# Hyperia graphics reference library

## 2026-09-23 — Shadow-aware meadow leaf illumination

Current status: **implemented and source-tested; native pixels, visual gain and performance are not yet qualified.** The completed native176 capture remains the baseline.

- [x] Restrict an orientation-independent leaf-scattering floor to the explicit meadow-field candidate: ambient `0→0.5`, with attenuation `0.2` and the existing leaf tint/root-height gate unchanged. This adds at most `0.1 × shadowed direct-light RGB × tint × height gate` per analytic light. It is an additive artistic approximation, not energy-conserving transmission, indirect ambient or emissive light.
- [x] Select the same immutable recipe in the actual ambient node and base, cloned, representative and installed-chunk material metadata. Legacy fine, folded, sheath, rooted-fan and canopy paths retain ambient zero. No new pass, texture or shader input; geometry, density, placement, wind, normals, albedo, AO and work/time limits are unchanged. Exact inverse editing reproduces the prior source.
- [x] Pass **244 unique tests across six files**: 169 shape/wind/cell cases, 64 appearance cases and eleven full-field grounding cases; 29 other pond scenarios were not selected. The new tests construct and evaluate installed Three's actual SSS contribution graph, checking both faces, light/view variation, root gating, zero already-shadowed light and the per-light bound. They also cover all three LOD/precompile owners and cloned-node identity; they do not simulate a renderer or shadow map.
- [x] Pass no-emit typechecking (**768 roots / 2,572 files / zero diagnostics / 82 stable pins**), scoped lint and formatting. Retain the initial focused-test assumption failures (a wrapped graph node and three—not one—representative LODs); corrected focused tests and the complete appearance suite pass. Independent source review found no unintended default, geometry or clone change.
- [x] Reverify **145 protected artifacts and 13 unrelated files**. Saved localhost3333/database remain intact; the prior private runtime/browser are stopped. No unqualified candidate promotion.
- [ ] Build89/runtime131/native177: compare all four noon views against complete native176, verify actual live chunk node values and emitted grass shader changes, and preserve exact geometry/root/mask/population, flowers, terrain, wind, quality and budget guards. Retain ordinary full-scene timing, restored far-grass diagnostics and strict terrain compilation.
- [ ] Require paired lower-sun review before accepting the lighting: clearer green leaf faces without glowing shadow regions, flattened contrast or washed-out tips. This cannot fill genuine ground gaps. Keep wider grass composition, natural shores, tactile pavilion/dock materials, island dressing and sustained 2× performance open.

Reference checked against the installed Three 0.186.0 source: [Three.js SSS material](https://threejs.org/docs/pages/MeshSSSNodeMaterial.html). Its experimental scattering support is a mechanism to evaluate, not evidence that this coefficient is visually correct.

Evidence: `inland-pond-integration01-UNQUALIFIED/meadow-leaf-fill-source-review01.json` (SHA256 `1fd187ace04c67126dc77208508fe56f23a69d8e3718a88abdd458b4e770d010`), service-layout `meadow-leaf-fill-{shape01,grounding01,appearance01,types01,lint01,format01}`; focused `tests01` failure and `tests02/03` passes remain retained.

## 2026-09-23 — Swept-geometry kernel checkpoint

Current status: **source verified; native176 completed the full route and strict shader checks once at unchanged quality and limits. Art and sustained-performance acceptance remain open.** Native175's failure below is retained, not reclassified.

- [x] Add the missing v10 field LOD2 `13_12` reconstruction with observed 128/16 terrain owners, exact input/output geometry and attribute hashes, swept bounds and masks: 2,262 input clumps → 2,193 retained, 69 pad rejections, 64 partial clumps and 189 masked blades. This is current-source evidence, not replay of an unretained browser packet.
- [x] Reject and fully revert the direct-native-iterator-method experiment: paired medians changed only +0.25% / −0.18% across the two workloads. The sampled iterator attribution was not proof of wrapper overhead.
- [x] Measure major fitting stages in a private, in-memory diagnostic with unchanged inputs, math, yields and caps. In the northern cell, swept geometry was the largest measured phase (~65 ms), followed by root fitting (~50 ms). These running-slice measurements include instrumentation and preemption, not exclusive CPU or native timing.
- [x] Extract the unchanged swept-vertex math into a plain local function while retaining the exact generator loop, blade suspension boundaries, live borrowed reads, arithmetic, work charges and limits. The inverse edit restores the previous source byte-for-byte. No grass density, geometry, placement, wind, shader or default changes.
- [x] Compare four baseline and four candidate fresh isolates per workload in ABBAABBA order. Northern-cell median **188.796 → 143.642 ms (23.92% lower)**; western-cell median **142.086 → 133.983 ms (5.70% lower)**. Serialized inputs, numerical outputs and operation counts match within each group. The western range includes a slower candidate sample; this is not a guarantee, FPS or browser qualification.
- [x] Pass **642 unique tests across ten files**: 631 core/terrain/worker/client/coordinator cases and eleven full-field cases. The other 29 pond scenarios were not selected. Pass no-emit typechecking (768 roots / 2,572 files, zero diagnostics, 82 stable source pins), scoped ESLint and formatting.
- [x] Restore the exact 607-byte ignored server-build manifest from independently hash-verified deterministic bytes. The original cloud placeholder was preserved, then moved metadata-only to service-layout `competitive-build-icloud-placeholder-preserved-20260923.json` after its temporary location was detected as an extra generated JSON during build preflight. Same inode, no hydration or deletion; all 145 original protected hashes match. Retain the initial preflight failure and recovery receipt. This does not resolve iCloud generally or complete workspace migration.
- [x] Build88 changes only the grounding source against build87: 1,096 other compiled inputs, six build configurations, nine bundle roles and compiled grass settings remain exact. Native176/runtime130 completed startup, all four stills including the previously failing landing, the six-second flower-wind capture, far-grass measurements and ordinary held timing on native Apple M5 Metal WebGPU. Rendering remains **1280×720 / DPR1 / MSAA4**, not a sustained 2× qualification. Startup took **26.355 s**; the longest complete grass-plus-flower cut took **4.015 s**.
- [x] Pass strict terrain compilation after the normal captures: all five receipts share a valid program pair, with **35 owned samples / 18 guarded rock samples / five height reads / five PCF sites**. Four full/far-hidden diagnostic blocks and the ordinary full-scene hold each retain twelve usable samples. Ordinary terrain-containing world-pass GPU time is **10.781 ms median (10.617–12.648 ms)**, not total frame time, exclusive grass cost, FPS or causal improvement. Hidden-scene samples never qualify shipping performance.
- [x] Restore visibility, timing hooks, camera and clock; destroy all owned timing resources; close the owned browser; stop runtime130 and remove only its disposable database. Reverify 145 protected artifacts and 13 unrelated files. Saved localhost3333 still returns HTTP200 with its original database. Source checkpoint `36efeac4db3d` is pushed under the user's account; no candidate-default promotion.
- [ ] Continue visible grass/ground integration and wider island art. Root and independent reviews show no obvious new regression, but dark edge-on/planar blades, exposed smooth bright ground, small distant flowers and plain pavilion/dock materials remain. The proposed low-leaf `.35→.65` curve change mostly straightens a subset of leaves; defer it without meaningful projected-union coverage evidence. Next, test bounded shadow-aware thin-leaf illumination with geometry, density, root/tip colors, terrain and budgets fixed, comparing noon and lower sun. This cannot fill real ground gaps. AAA appearance, full motion/LOD, gameplay, stream and sustained-performance acceptance remain open.

Evidence: `inland-pond-integration01-UNQUALIFIED/meadow-field-swept-kernel-source-review01.json` (SHA256 `d3ae8085ea265f40d52407257cb4d3612973306c4eea900e835f138fc79bf632`), service-layout `meadow-field-north175-{profile01,golden01}`, `meadow-field-stage-timing01`, rejected `meadow-field-native-delegate-abba01`, and `meadow-field-swept-kernel-{abba01,regression01,matrix01,types01,lint01,format01}`.


Native evidence: `isolated-build88-report.json` (`30661c6f712dc5331d53fb32ce1e67cfce609eccaf118c33e27dcfc5e227e783`), `native176/process.json` (`f58cabef08bfa47a2035be314e31dd84ee8fb142c432b22356f2d56dd2f6d6f1`), stopped `runtime130/process.json` (`58014bce32c6301f409f18646e14defb99ce72b240061136db6de95078c45593`) and `meadow-field-swept-kernel-native-review01.json` (`775cdb57fb367c4b488b655a570b73040ef891a1f8c72c7e35ebfd850219a0ef`).

## 2026-09-23 — Native worker retest: loading remains open

Current status: **build verified; native175 FAILED/partial; no candidate-default promotion.** The modest worker optimization below did not solve the native loading blocker.

- [x] Build87 contains exactly one changed compiled source input versus build86 (the worker entry), with 1,096 others unchanged, six build configurations, nine bundle roles per build and identical compiled grass configuration. Source checkpoint `3f5cbd0571bad4caa8b85841314a1df857b022a0` is pushed.
- [x] Run the isolated Metal WebGPU scene with unchanged quality, placement and limits. Startup and the first three grass transitions completed; their screenshots and the flower-wind check were retained. Matched native174/native175 images show no obvious geometry/population/material regression, but angular grass, dark edges, exposed bright ground and tiny distant flower marks remain.
- [x] Retain the failed landing transition: `gcell_v1_13_12`, LOD2, 223,364 merged operations and 251.5 ms cumulative slice elapsed time against the unchanged 250 ms limit. This differs from native174's `11_16` cell. Recorded terrain descriptors show a 128/16-resolution northern seam; the exact failed worker packet was not retained.
- [x] Keep timing interpretation honest: `active_cpu` includes preemption/GC and is not exclusive CPU measurement. A 28.9 ms peak clock interval and a `grounding_operation` label do not identify a unique hot path. Twelve host samples showed AC power and thermal state zero, not absence of CPU contention.
- [x] Close the owned browser, restore camera/clock, stop runtime129 and remove its temporary database. Reverify all 145 protected artifacts and 13 unrelated files; the saved localhost3333 returns HTTP200 and its database/container/volume identity is unchanged. No additional Mac restart is required for this checkpoint.
- [ ] Profile broader fitting costs and cover the newly exposed mixed-resolution field workload before another native trial. Existing same-cell generation tests use a different configuration/LOD0 and do not close this coverage gap. Do not repeatedly retry, raise limits or reduce grass quality to obtain a pass.
- [ ] Complete landing, all four views, final strict shader/material checks, far-grass measurements and ordinary held timing. Native175 provides no completed landing hold, FPS/smoothness or performance acceptance.
- [ ] Continue reference-led grass/ground integration and wider island art after loading is reliable. The prior 641 source tests remain valid historical evidence, not a claim that this failed native run passed.

Evidence: `inland-pond-integration01-UNQUALIFIED/meadow-field-worker-forwarding-native-review01.json` (SHA256 `ebf4246ed4fa043ab46ffbd9ac75fedae95ff403387bf57450c7a8dcbeb12d91`), `isolated-build87-report.json` (`88b5457e0a5b2ff2762e752162c8894f1fb3f05c7380a063107fa99d2a945d12`), `native175/process.json` (`4a21d1429c4daaae992162c6103f68303f78c1837959c05f1f64a0024b9804ab`) and stopped `runtime129/process.json` (`8486dd034855fa6a358f4b8f27dfdf9fb9fd044814941bc122d6cd807223fb62`).

## 2026-09-23 — Profiled grass-worker forwarding checkpoint

Current status: **source verified; a modest Node-worker improvement measured; native landing/loading and visual acceptance remain open.** This supersedes the missing-regression and unmeasured-hotspot items in the flower-distribution checkpoint below, not its failed native result.

- [x] Reconstruct the previously missing v10 meadow-field LOD2 cell `gcell_v1_11_16` at the recorded landing focus. Pin all geometry/placement/fitted buffers, visibility and swept bounds: 1,898 clumps / 22,776 visible blades, no rejection or masking. This is a complete current-source reconstruction, not a byte-exact replay of the unretained native174 browser job.
- [x] Retain the actual worker CPU profile and complete serialized reconstruction before transfer. Its 106 samples point toward worker generator delegation and road-distance work; sampling includes task waits, GC and Inspector overhead. The regular 64-grid owner makes the refined-indexed endpoint proposal inapplicable. Convex-polygon batching had no effect with zero applicable polygons and was removed.
- [x] Forward the worker's fitting iterator directly after lazy setup. Keep every yield/resumption, final step, cold rebuild attribution, seeded cumulative charge, cancellation and ownership cleanup intact. Do not alter blade geometry, placement, road/height arithmetic, materials, wind, pool sizes or any time/work limit.
- [x] Compare four baseline and four candidate fresh isolates in ABBAABBA order with identical serialized inputs, numerical receipts and 431,890 operations. Median active-slice time is **146.284 → 141.238 ms (3.45% lower)**; ranges are 146.157–151.729 versus 139.684–145.648 ms. This is one bounded Node comparison, not exclusive CPU, a guaranteed browser gain, FPS or proof that the loading failure is fixed.
- [x] Verify **641 unique tests across ten files**: 65 real-worker cases, 566 core/terrain/client/coordinator cases and ten full-field cell/tier cases. The matrix also exercises production handoff/publication and cold/warm coordinator paths. Its 29 other scenarios were not selected, not claimed passed.
- [x] Complete no-emit typechecking (768 roots / 2,572 files, zero diagnostics, 82 stable pins), scoped ESLint and formatting. Preserve the initial optional-cache-access type failure and line-wrap formatting failure; both were corrected in the test only. Independent review found no forwarding/ownership blocker; arbitrary internal return/throw/reentrancy is source-reviewed, not falsely claimed as a new browser test.
- [x] Reverify all 145 protected artifacts and 13 unrelated files. Saved localhost3333 and its database remain untouched; no new native session or candidate-default promotion occurred.
- [ ] Build and test this exact worker change in the isolated native Metal WebGPU scene. Native174 remains **FAILED/partial** until a new run completes the landing transition, all four views, strict terrain/shader checks, far-grass and ordinary held timing. A 3.45% Node improvement alone does not close that blocker.
- [ ] After loading verification, continue coverage-first grass/ground integration and wider world art. The next reference-led geometry proposal bends only the lowest leaf outward earlier, preserving counts/root/tip/height/width and updating analytical normals; it is not implemented or visually accepted. Require fresh fits, unchanged caps, matched images and wind review; unchanged triangle counts do not prove equal fill cost or better coverage.

Evidence: `inland-pond-integration01-UNQUALIFIED/meadow-field-worker-forwarding-source-review01.json` (SHA256 `a8322c6bbb8318bd75b6ec7f1ce68feaef85c29c6a0c05c01c3d00da76b88ee3`), service-layout `meadow-field-west174-profile01` (raw CPU profile SHA256 `65967e5c14b1fd70c8b38d7fdb67765c4268b66f71202b50506db2925f130b57`), and `meadow-field-worker-forwarding-{abba01,tests03,regression01,field-matrix01,types03,lint02,format02}`. The earlier native174 failure and unsuccessful CPU candidates remain retained as historical observations.

## 2026-09-23 — Fuller meadow flower distribution

Current status: **source implemented, tested and pushed; isolated build passed; partial native visual improvement retained, with a real grass-fitting budget failure still open.** This supersedes the earlier “broader flower coverage pending” source task, not the outstanding art/launch acceptance gates.

- [x] Spread the existing four candidates per 8 m cell across four jittered quadrants instead of small local clusters. Roots stay within 1–3 m / 5–7 m quadrant intervals, with at least 2 m separation across neighboring cells; exact rounded placement and all eight neighboring directions are tested.
- [x] Raise suitable-habitat acceptance from `0.6 + 0.35 × (1 − patch)` to `0.9 + 0.1 × (1 − patch)`. The nominal uniform-patch mean changes from 0.775 to 0.95; actual visible population gains are not guaranteed because relocated roots receive fresh water, road, terrain and resource-clearance checks.
- [x] Keep the 484-candidate ceiling / 512-instance pool, authored flower geometry/material/shared wind, grass, light, terrain and scheduling budgets unchanged. Historical flower matrices are intentionally changed, not claimed identical.
- [x] Verify 262 unique tests across five files (zero skips), scoped ESLint and formatting, and the no-emit typecheck (768 roots / 2,572 files, zero diagnostics, 82 stable pins). Source checkpoint `8ae3ccfbd0d733836631b6017152689c3b2848d7` is pushed.
- [x] Build86 verifies exactly one changed compiled input and 1,096 unchanged inputs; all six build configurations, nine bundle roles and 145 protected artifacts match the admitted baseline. This is build evidence, not graphical acceptance.
- [x] Correct the private far-grass diagnostic's exact-snapshot false positive: five source-backed idle maintenance counters may advance monotonically; all configuration, population and resource identities remain strict. All 63 offline receipt checks pass. Native172 remains failed/partial and has no completed landing screenshot or far-cost timing.
- [x] Review the three completed native174 Metal WebGPU image pairs. Arrival and woodland flowers are spread more broadly, without an obvious rigid grid in these views. Prepared instance counts change 205→262, 180→215 and 191→232; these are retained population counts, not visible pixel counts. The close view contains one clear nearby sprig instead of the previous nearby pair. No obvious new path/pavilion/water intrusion; this remains an incremental opt-in improvement, not AAA acceptance.
- [x] Preserve the six-second wind recording and inspect three extracted frames. Its shared clock/population/camera checks pass; sparse frame inspection does not qualify smooth traversal, all wind phases or temporal artifacts. The existing grass remains visibly angular/dark over exposed olive ground.
- [x] Preserve native173's diagnostic failure: generated vertex storage names changed but the bound shader operations did not. Native174 narrowly reuses the existing declaration-bound bijection; all remaining vertex bytes and complete fragment bytes stay exact. Parent replay passes three positive / 15 adversarial cases plus exact fragment comparison; independent review agrees.
- [ ] Fix native174's real landing-transition grass-fitting failure before another qualification run: cell `gcell_v1_11_16`, LOD2, bounds `275..300 / 400..425`, worker 403,334 operations / 250 ms, merged supervision 251 ms against the unchanged 250 ms limit. This is cached fitting, not cold admission. The 38.8 ms peak elapsed slice may include GC/preemption; the final `endpoint_owner` yield does not prove the hotspot. No evidence establishes flower placement as its cause.
- [ ] Add the missing v10 field LOD2 `11_16` regression and measure cached-worker plus coordinator paths. Investigate certified same-face endpoint reuse without changing height arithmetic, charges, dependencies or fallbacks. Any reconstruction must be labelled as such: the historical raw job packet was not saved. Do not raise budgets or retry blindly.
- [ ] Complete the fourth landing view, full final terrain/shader qualification, far-grass and ordinary held timing, and traversal/grid/fade review. Native174 is **FAILED**, not a completed four-view/performance pass; native172 also remains failed/partial.
- [ ] Qualify performance separately under controlled host conditions; cross-build timing is not a causal improvement measurement. Do not promote this isolated candidate to saved localhost defaults from source/build tests alone.
- [ ] Address the visible dark-blade / exposed olive-ground contrast with coverage-first lower-leaf rest shapes and overlap; judge actual ground occlusion and silhouette, not another small global normal/height/width tweak. Keep root density fixed initially and measure any added geometry/fill cost.
- [ ] Continue the wider world-art work: grass depth and ground integration, natural banks/paths, water, pavilion/arena character and coherent island dressing. Flower 24–32 m fading still limits distant coverage.

References revisited: [Grassworks live demo](https://grassworks.techredux.co/demo), [Three.js instanced uniforms](https://threejs.org/examples/webgpu_instance_uniform.html), and [GPUOpen procedural grass](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/). Grassworks was visually inspected; its HUD is not a verified benchmark. Its public [blade/rest-bend](https://grassworks.techredux.co/docs/grass/blade), [color/surface](https://grassworks.techredux.co/docs/grass/appearance) and [LOD](https://grassworks.techredux.co/docs/performance/lod) guides also inform the next coverage/rest-shape study. Its source is commercially distributed, not assumed open source; no purchase or external source-code copying occurred.

Evidence: `inland-pond-integration01-UNQUALIFIED/meadow-flowers-distribution-source-review01.json` (SHA256 `81ec6f0e87f1492f2bd04c59964dd2b834ca5ca130ece38cb5da3654af08ec04`) and `isolated-build86-report.json` (SHA256 `053ddefeccb3968dbe14f96c84bb853b1929f3616b3586c6153b0b8f5a8ace82`). Native174 receipt SHA256 `58b953915194c28757d2b2303b882c1d233f90ebc128e8923f6801754b50e2f4`; runtime128 terminal receipt SHA256 `d18daa55836cdca82f2c4d29787b00aefcabf037ebaf749eacf4efae8232d095`. Owned browser closed, private runtime stopped and disposable database removed. Saved localhost:3333 and its database were not replaced.

## 2026-09-23 — Meadow shading relief and broader flower coverage

- [x] Isolated an **18° transverse shading-normal relief** trial in the explicit `meadow-field-v1` candidate. The normal bend fades at the tip; geometry, placements, albedo, AO, scattering, lighting and defaults are unchanged. This adds an active width varying and fragment arithmetic, not physical leaf thickness, new ground coverage or free rendering work.
- [x] **956 unique tests / eleven files pass**, with 14 historical fixture skips. Expanded actual-graph checks cover both faces, the tip taper, sloped ground, wind and cancellation. Full no-emit check: **768 roots / 2,572 files / zero diagnostics**, 82 stable source pins. Nine full-cell numeric placement/grounding outputs match the prior lower-layer pass exactly, including root corrections and masks; fresh per-run surface UUIDs are excluded from numeric comparison. The first grounding run's nine stale flat-material receipt failures are retained; only the two intentional material expectations were updated.
- [x] Source checkpoint `c59cb944c5cd` is pushed under the user's account. Saved localhost3333/database, 145 protected artifacts and 13 unrelated worktree files remain unchanged.
- [x] **Native172 retained three matched-camera noon views, not a completed capture.** Grass/flower populations remain **149,178/205**, **116,811/180**, **112,173/191**; each retained view has submitted LOD0/1/2 programs with the exact 18° relief term at 1280×720, DPR1, MSAA4, postprocessing off. Flower-motion diagnostic completed. This does not qualify four-view terrain, movement, lower-sun or sustained 2× performance.
- [x] Preserved **two failed native runs**. Native171 hit the historical no-fold shader predicate; native172 corrected that admission but stopped before any timed block because the new cost helper incorrectly required an idle-maintenance counter to stay fixed: `grounding.worker.admissionOperations` **104298 → 104302**, the only differing retained profile scalar. This is a diagnostic comparator defect, not demonstrated population drift. No landing still, held timing or final strict terrain qualification was produced. Visibility and camera/clock were restored; the owned browser and isolated runtime127/temporary database were closed cleanly.
- [ ] **Relief is not visually approved or promoted.** Primary and independent review of all three image pairs found no decisive improvement: planar faces, dark thin edges, angular crossings and exposed ground persist. Natural wind differs between captures, so local blade differences are not proof of a material change. Keep the opt-in research source; stop this tuning loop and move to broader flower distribution. Repair the cost comparator by separating telemetry from configuration/population, retaining exact owner, buffer and cleanup guards before the next timing run.
- [x] Final checkpoint verified **145 protected artifacts, 1,097 compiled source inputs, four source/test files and 13 unrelated worktree files unchanged**; earlier content of all eleven checklist/ledger mirrors preserved. Saved localhost3333 still returns HTTP200 and its named database volume remains intact. The obsolete 40-day uptime warning is resolved by the intervening reboot; no additional restart is indicated by that old reading.
- [ ] Next flower trial: redistribute the existing four candidates across four quadrants of each 8m cell instead of tiny central clusters, then modestly increase habitat admission. Retain the 512-instance pool, 484-candidate ceiling, existing two-head sprigs, scheduling and all navigation/resource/water clearances. Native170 pools are only **205/180/191/135**; capacity is not the present coverage bottleneck. The separate 24–32m fade still limits island-scale visibility and remains open. Verify real counts, clearance cost and matched images before acceptance.
- [ ] Continue natural water banks, tactile pavilion materials and broader island composition after this bounded grass decision. Stop height/width-only grass iteration.

Evidence: inland-pond `meadow-relief-source-review01.json` (SHA256 `98df73cd3ed2a781098172bd2fcb0784e7e05f12d67560ea6098838aa9179b61`), `isolated-build85-report.json` (`00626be3799c21cd309f1ca0589bf4d7c311682a6c26a49e23983d1c7ed4aa67`); service-layout `meadow-relief-regression01`, `-graph02`, `-grounding02`, `-types02`, `-hook01`, `-helper-preflight01`, `-helper-preflight02`, `-native172-01`, `-final-review01`. Final bounded review: `meadow-relief-native172-review01.json` (`b7ef7c70ad57991c4cae1d9d809aa4f7a125d5a3fbc8a70d741ba0036a385059`). Geometry-factory bytes at all three tiers equal native170; historical GPU root/Y readback is not available. References remain [Grassworks](https://grassworks.techredux.co/demo), [GPUOpen grass normals/detail](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/) and [Three leaf scattering](https://threejs.org/docs/pages/MeshSSSNodeMaterial.html); this relief is an explicit art hypothesis, not a claim of copied source or a reference-mandated coefficient.

## 2026-09-23 — Lower meadow layer native-tested; shading and far cost remain open

- [x] Bounded actual-factory study separates low-leaf height from reach. The explicit field candidate changes only low-role height **0.68→0.52** and arc **1.10→1.30**. Middle/tall leaves, widths, roots, topology, half-metre placement, materials, flowers, terrain, limits and defaults remain unchanged. Reversing those two field-local values and comments exactly reproduces build83's full geometry-owner source.
- [x] Authored triangle sums in the bottom 20 cm gain **53.4% / 44.3% / 42.5% horizontal projected area** across near/mid/far, but only **5.2% / 6.3% / 6.7% at 15° elevation**. Total side-projected area decreases about 6.5%. These are not occlusion-resolved pixels or proof of a fuller-looking meadow. Near/mid maximum authored radius grows **5.84%**; every placement is freshly fitted.
- [x] **894 unique tests / ten files pass**, with 14 historical fixture skips; full no-emit check **768 roots / 2,572 files / zero diagnostics**, 82 stable pins; scoped lint passes. Three independent native169 fingerprints protect all roots and all middle/tall position/normal/UV bytes. The initial fixture-less grounding invocation skipped all 38 tests and is explicitly excluded from passing evidence.
- [x] All nine real full-cell fits and **18 cold/warm production coordinator runs** complete under unchanged budgets. Near work is **855,676 / 852,375 / 931,790** for cells 13_17/12_16/15_17. The road cell now retains **2,069 of 2,212** placements (112 pad / 31 water rejections; 78 partial clumps / 350 masked blades), versus 2,073 previously; altered support is recorded, never forced equal to 169. No truncation, population-setting reduction or cap increase.
- [x] Deferred nonuniform curve stations: exact perpendicular centerline error improves for upper middle/tall curves but worsens their root intervals by **28–32%**, with only 3.7% improvement to near worst error and no overall middle/far improvement. This does not justify bundling a second shape change into the ground-coverage trial.
- [x] Cost audit of native167→169 matches actual submitted grass draws to retained LOD chunks. Same 25 grass draws: triangles **−7.49%**, vertex×instance workload proxy **+31.22%**; far proxy **+95.74%**, now 58.92% of that total. Selected installed matrix/root/mask arrays grow **14.32→27.18 MiB**. This is not hardware invocation count, total VRAM, or causal timing evidence.
- [x] **build84/runtime126/native170** completed four matched views against 169 on Apple M5 native Metal WebGPU at **1280×720/DPR1**, unchanged full-scene quality. Actual factory and uploaded geometry match at every tier; all roots and middle/tall attributes remain exact, with only the low-role shape changed. Freshly fitted grass counts are **149,178 / 116,811 / 112,173 / 156,525**; flower pools remain **205 / 180 / 191 / 135** with exact unchanged authored attributes. Terrain programs remain identical and strict **35/18/5 plus five PCF** qualification passes.
- [x] Startup **26.892s**, longest cut **3.186s**. Twelve mixed-world GPU samples: median **10.912ms** versus 169's **11.338ms**, current range **10.224–12.714ms**. Sequential natural wind, actors, warm-up and changed retention prevent causal timing or FPS claims. The six-second wind clip has 179 decoded frames; six sampled frames were inspected, not continuous motion/LOD acceptance. All 36 timing resources, owned browser/runtime and temporary database were released; saved localhost3333/database, 145 protected artifacts and 13 unrelated files remain intact.
- [ ] **Two-reviewer art verdict: modest lower-leaf overlap, not finished grass.** The close-up improves slightly; the other three views change subtly. Broad flat faces, dark razor-like edges, angular crossings, exposed bright ground and sparse island-scale flower flecks remain. Retain only as an opt-in development candidate; no AAA, sustained 2× performance or default promotion.
- [ ] Next: one bounded transverse shading-normal relief trial with geometry, placement, terrain, albedo, AO and scattering fixed, compared at noon and lower sun. Reject edge wires, plastic highlights or negligible benefit; this is shading, not physical blade volume or new pixel coverage. Separately test strictly restored full/far-hidden/full/far-hidden marginal cost; a reduced diagnostic scene is never shipping acceptance. Stop height/width-only iteration and return to fuller flower distribution, natural banks, tactile pavilion materials and broader island art.

References remain [Grassworks](https://grassworks.techredux.co/demo) and [GPUOpen curved grass](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/); independent geometry/detail/density principles only, no external code copied or mesh-shader capability claim. Evidence: inland-pond `meadow-field-layer-study01.json` (SHA256 `8ffcf4bfd2313b29bdaead3b8e5c11eb6336881bbbfdfc619a931645548e111e`), `meadow-field-stations-review01.json` (`453ced6f4605220af37b8ce48e69e9561c26059e9e9b25d8d1a507aaa62d6199`), `meadow-field-cost-review01.json` (`135cd19d215029fede6bbf2277aa72407be8834a923acd0129e3fd29391b422f`), and `meadow-field-layer-source-review01.json` (`a273ca08a761ac664c3e89ac20ddaf4ff4ec14012a20b0d7df2ddd085b4322a7`). Service-layout `meadow-field-layer-regression02`, `-grounding02`, `-types01`, `-lint01` retain the current verification. Native evidence: `meadow-field-layer-native-review01.json` (SHA256 `b1a9a092f963dfe546d3659fad5ab5336ea1ccdfe382ae5dce0ec5f50afe100b`), native170 stills/wind and 275 verified receipt files; service-layout `meadow-field-layer-build84-01`, `-runtime126-01`, `-native170-02`, `-native-review01`, `-runtime126-stop01`. The first `-native170-01` invocation omitted the required worker environment variable and failed before browser/artifact creation; it is retained, not counted as a pass. Source checkpoint `0985cde9ed9f` is pushed. Sections below describe prior checkpoints; art, continuous motion and sustained-performance acceptance remain open.

## 2026-09-23 — Fine-ribbon meadow native-tested; close-up volume and cost still open

- [x] Added explicit `meadow-field-v1` without changing any default, saved playable, or historical recipe. Half-metre placement uses **21/21/12 blades** in **3/2/2-segment ribbons**, seven complete three-leaf fans near/mid, physical ribbon normals at every tier, and existing height-consistent wind. Source width/arc ratios are **0.028/0.40**; short/mid/tall height factors **0.68/0.84/1**, width factors **0.95/1.05/0.80**, and arc factors **1.10/1/0.80**. Quarter-width basal roots reduce rectangular feet; the analytic width-recovery parameter is 0.2, but actual triangle edges interpolate to the first interior row (1/3 or 1/2). That shape needs visual inspection.
- [x] Kept 25m ownership cells, 12/40m LOD boundaries with hysteresis, 140m range, native-quality settings, exclusions, full distant placement, and all fitting/transport/time limits. The new grid is **not** a source-index superset of the previous grid. All masks, root corrections and retention are recomputed. Single-cell coverage experiments cannot be mixed with this candidate.
- [x] **891 unique tests pass in 10 files**, with 14 fixture-dependent historical skips. This includes 18 new geometry cases, selector/manager/teardown tests, unchanged historical geometry, normals, wind and storage checks, and all nine new full-cell cases. Full no-emit type check: **768 roots / 2,572 files / zero diagnostics**, 82 stable pins. Scoped lint passes.
- [x] Three real cells at all three tiers pass unsliced core fitting, cached-worker/handoff/publication, full main continuation, and **18 cold/warm production coordinator runs**. Near cells 13_17, 12_16, 15_17 process **2,494 / 2,415 / 2,212** placements, retaining **2,494 / 2,415 / 2,073**, at **855,660 / 852,307 / 931,490** work units under the unchanged 1M cap. Road-side rejection remains explicit (109 pad, 30 water; 76 partial clumps and 342 masked near blades), not missing-budget grass.
- [x] Preserved unsuccessful trials: 24-blade full-width-root and quarter-width-root variants failed the road cell after **1,911 / 2,085 of 2,212** placements. Neither failure is relabeled as a pass. The selected seven-fan design reallocates unapproved geometry; it does not relax accounting, raise limits, truncate placements or change the approved/default scene.
- [ ] Cost and reliability remain bounded observations, not launch approval. Nominal near/mid blade density is **1.715×** the previous captured recipe; vertex ratios are **0.800/0.953/1.960**, triangle ratios **0.504/0.572/1.960**. Far work and root/instance storage increase. The raw uncached diagnostic still hits 250ms in the three road-side tiers, while the actual production cold/warm coordinator paths pass; their separately admitted retained-owner preparation is not the raw diagnostic path. No sustained frame-time, total-memory, streaming or 2× performance claim.
- [x] **build83/runtime125/native169** completed all four matched views on Apple M5 native Metal WebGPU at **1280×720/DPR1**, unchanged daylight and full-scene quality. Current factory and uploaded geometry match at all three tiers, with physical ribbon normal shaders and fresh placement/masks. Grass counts are **149,220 / 116,854 / 112,212 / 156,569**; flower pools remain **205 / 180 / 191 / 135**, with exact unchanged authored flower attributes. Full terrain programs remain identical to167 and strict **35/18/5 plus five PCF** qualification passes.
- [x] Preserved **native168's failed first-camera capture**: the private recorder assumed the old **1,276**-candidate cell quota. An explicit, exact field-profile check now derives **2,500** from 25m cells/0.5m spacing; historical checks remain 1,276. No production limit or deadline changed. Six new scalar/history cases pass; the full helper suite is **66 pass / two stale historical source-pin failures**, not all green. Ten targeted transition checks pass. The two old v15 pond/head cases reject an outdated `GrassPlacementCell.test.ts` hash; their evidence was not rewritten.
- [x] Startup **27.089s**, longest cut **3.268s**. Twelve mixed-world GPU samples: median **11.338ms** versus 167's **9.798ms**, current range **10.355–12.517ms**. Current sampled pass has 191 draws/2,754,874 triangles. This sequential, changed-density/topology observation does **not** establish causal grass cost, FPS, a performance win, or sustained 2× acceptance. Six-second wind clip decodes to 179 frames; six sampled frames were inspected, not full motion/LOD acceptance. All timing resources and owned browser/runtime were released; temporary database removed, saved localhost3333/database and 145 protected artifacts plus 13 unrelated files intact.
- [ ] **Art verdict: finer, not finished.** Both reviewers prefer 169's finer and more even distribution, with substantially fewer broad papery blades and readable flowers. Close-up still shows angular flat ribbons, separated thin bases and exposed bright ground; fullness/volume is not convincingly solved. Keep as a development candidate, not a playable/default promotion. Next: a bounded near-ground foliage/silhouette study, separating geometry coverage from substrate contrast, while profiling the increased distant instance/storage cost. Do not widen every blade or darken the ground to conceal gaps. Continuous wind shimmer, LOD traversal, sustained performance and broader island art remain open.

Research basis: independent blade/density/detail controls in [Grassworks](https://grassworks.techredux.co/docs/grass/blade) and [GPUOpen curved grass rendering](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/). Principles are adapted to the existing WebGPU implementation; no external code copied or DirectX mesh-shader support implied. Evidence: service-layout `meadow-field-regression01`, `-grounding01`, `-bank01/02/03`, `-types01`, `-lint01`; inland-pond `meadow-field-source-review01.json`, SHA256 `a7c309cd5343a1650de8c91b398ccdf842a1447f553341cd422783c62e11c640`. Native evidence: `meadow-field-native-review01.json`, SHA256 `24127af84e4352fcc6b2144532309db0355b26f4907a5e151ee9203024b13a4c`; native169 stills/wind/275 verified receipt files, native168 failure retained, and service-layout `meadow-field-build83-01`, `-runtime125-01`, `-native168-01`, `-native169-01`, `-transition-tests01/02`, `-native-review01`, `-runtime125-stop01`. Source checkpoint `b4c304cde` is pushed. AAA, motion and sustained-performance acceptance remain open.

## 2026-09-23 — Lower-canopy correction native-tested; finer meadow redesign required

- [x] Decoupled meadow leaf width/reach from shortened stature in the existing opt-in `meadow-canopy-v1` recipe. Shared-height widths are **1.1 / 1.25 / 0.86**, arcs **1.15 / 1 / 0.78**; heights remain **0.68 / 0.84 / 1**. No density, lighting, substrate, flower, selector or default changes. Same **24/24/12 blades**, topology, narrow root sheath and wind equation.
- [x] Bounded actual-factory studies compared four recipes and one targeted middle-leaf correction. The selected recipe restores summed lower/middle vertical projected triangle area to **115.8%/89.1%**, **105.6%/88.3%**, **106.7%/95.6%** of native165 across near/mid/far. These are authored area sums, not occlusion-resolved coverage. Tall-role attributes, all Y coordinates, UVs and indices remain exact to166; this does not guarantee the entire upper silhouette is unchanged.
- [x] **296 unique tests pass in seven files**, with 14 fixture-dependent pond skips. Added independent clipped-height area regression gates and immutable166 tall-blade digests; historical/default digests, surface normals, winding, LOD prefixes and manager ownership pass. Full no-emit check: **767 roots / 2,571 files / zero diagnostics**, 81 stable pins. Scoped lint passes.
- [x] Fresh full-cell fits retain **1,272 / 1,247 / 1,054** of **1,272 / 1,247 / 1,125** placements at **983,315 / 976,769 / 990,569** work units under the unchanged 1M cap. Near authored radius grows **14.4%** to 1.147m; masks/retention are recomputed, not inherited. Main cached-worker handoff/publication paths complete.
- [x] Traced the repeated 250ms raw-worker timeout: the fixture sends monolithic `start`, rebuilding surfaces inside fitting. Production GVM's coordinator sends `prepare_surface` then `start_cached`, with separately reported/bounded admission and fitting ledgers; its cached/handoff path passes. The raw diagnostic genuinely fails in both current runs and the preceding166 source run; it is not the live GVM route. Combined cold work may exceed 250ms. Do not claim all worker APIs or long-run cache behavior are qualified.
- [x] **build82/runtime124/native167** completed four matched full-world captures on native WebGPU at **1280×720/DPR1**. Actual source/submitted geometry matches; all Y/UV/index and tall-role bytes retain166. Flower attributes/pools and full terrain shader hashes remain exact; strict **35/18/5 plus five PCF** qualification passes. New grass counts **76,111 / 59,586 / 57,220 / 79,846** honestly retain newly rejected/masked placements; no density reduction setting was introduced.
- [x] Startup **25.492s**, longest cut **3.114s**. Twelve mixed-world GPU samples have median **9.798ms** versus166's **10.912ms**; changed retention, natural wind/actors and sequential host conditions prevent causal or FPS claims. Six-second wind recording decodes to180 frames, but full motion/traversal/2× stability is not accepted. Owned browser/runtime stopped, temporary database removed, saved localhost3333/database and145 protected artifacts plus13 unrelated files intact.
- [ ] **Do not promote as finished art.** Both reviewers see fuller foliage than166, with readable flowers, but broad papery lower/mid strips, dark angular facets and separated roots remain obvious close-up. The tested24-blade family trades fineness for coverage; this is not proof of an absolute24-blade limit. Next: redistribute geometry toward more fine short/mid leaves and fewer high-detail tall leaves, explicitly accounting for masks, layouts, root fitting, LOD and GPU cost. No more width-only iterations or ground darkening to conceal gaps; no blanket budget increase.

References: [Grassworks independent blade controls](https://grassworks.techredux.co/docs/grass/blade), [density versus geometric detail](https://grassworks.techredux.co/docs/performance/lod), and [GPUOpen curved grass/coverage principles](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/) (DirectX mesh-shader implementation is not a WebGPU capability claim). No external implementation copied. Evidence: inland-pond `meadow-canopy-coverage-study01/02.json` (targeted02 SHA256 `4c9bd32c58239547e69514893eef7c75761cff75e19e28ceff5ce61e3617e137`); service-layout `meadow-canopy-coverage-geometry01`, `-grounding01`, `-bank02`, `-types01`, `-lint01`. Independent code review found no source/test blocker. Native evidence: `meadow-canopy-coverage-native-review01.json` (SHA256 `c347a157f6d39b7d28ab54b27ec1e0dd1980dc076b52504174abd2366b654593`), native167 stills/video/275 verified receipt files, and service-layout `meadow-canopy-coverage-build82-01`, `-native167-01`, `-runtime124-01`, `-runtime124-stop01`, `-native-review01`. Source checkpoint `117f531af` is pushed; defaults, sustained performance and AAA acceptance remain unchanged.

## 2026-09-23 — Native canopy inspected; coverage correction required

- [x] **build81/runtime123/native166** completed four matched full-world views on Apple M5 native Metal WebGPU at **1280×720/DPR1**. Actual submitted grass attributes match the pinned factory, including explicitly verified 16-to-32-bit index widening; every authored flower attribute remains identical to165. Terrain strict qualification passes with the same full vertex/fragment hashes and **35/18/5 texture-read structure plus five PCF sites**.
- [x] Grass clumps are **76,190 / 59,662 / 57,295 / 79,940**, versus165's **76,189 / 59,658 / 57,289 / 79,928**. Flower pools remain **205 / 180 / 191 / 135**. New fits/masks and common accepted transforms are recorded; retained counts are not visible pixel coverage.
- [ ] **Do not promote this trial as an overall visual improvement.** Two reviewers find finer silhouettes and clearer flowers, but materially more exposed bright ground and insufficient overlapping lower foliage. Hash-verified authored surface area is only **50.57% / 50.60% / 53.38%** of165 across the three tiers. Near-tier mean vertical projected area is **51.38%**; these are summed triangle areas, not occlusion-resolved pixels.
- [x] Startup **25.583s**, longest cut **3.258s**. Twelve mixed-world GPU samples give median **10.912ms** versus165's **10.977ms**; changed geometry/retention, wind, actors and sequential host conditions prevent causal attribution. The six-second wind clip decodes to 180 frames; six sampled frames were inspected, not full motion/LOD/contact acceptance. No sustained or 2×-resolution performance approval.
- [x] Owned browser/runtime stopped; temporary test database removed. Saved localhost:3333 returns HTTP200, its database and all 145 protected artifacts plus 13 unrelated files remain intact. Defaults unchanged.
- [ ] Next: deliberately restore low/mid foliage overlap while retaining finer upper blades; measure projected area before new full-cell fits and native review. Ground darkening cannot substitute for coverage. Existing topology is not a quality ceiling: if geometry composition is insufficient, explicitly re-budget and measure density/layout rather than silently reducing quality or relaxing limits.
- [ ] Before admitting 32-blade layouts, correct the two CPU `(1 << blades) - 1` mask boundaries and test 31/32-bit behavior. Current 24-blade rendering is unaffected. Existing full cells reach 990,552/1,000,000 work units; 32-blade main sweeps alone exceed that cap for 1,276 inputs. A 32-blade geometry-only counterfactual still yields just 73.14% of old projected area, so it is neither a sufficient coverage fix nor an admitted worker/GPU profile.

Evidence: private inland-pond `meadow-canopy-native-review01.json` (SHA256 `ed6824cd29d320f70914d0898b59c542909c47acdc69070ec9b126ca3e4191be`), `meadow-canopy-area-review01.mjs/.json`, native166 stills/wind/receipts, and service-layout `meadow-canopy-native-review02` / `meadow-canopy-area-review01`. The initial independent review rejected renderer index-type widening; review02 verifies the exact numeric conversion instead of skipping that check.

## 2026-09-23 — Mixed-stature meadow canopy implemented; rendered acceptance pending

- [x] Added explicit `grassGeometry=meadow-canopy-v1` under the existing fine-meadow/leaf-volume requirements. Eight three-blade plants replace six four-blade fans in the trial: shared plant heights, rotated short/middle/tall roles, finer widths and varied arcs. Existing candidates and default selection remain unchanged; native164 rooted-fan geometry hashes still match exactly.
- [x] Same **24/24/12 blades**, **360/216/60 vertices**, **408/216/36 triangles** per clump across near/mid/far; unchanged spacing, range, instancing, materials, wind equation and worker limits. Roots spread to a 6.5 cm ring, so fresh grounding and clearance are mandatory. Finer blades may expose more substrate or shimmer; equal topology is not equivalent coverage or cost.
- [x] **811 tests pass across eight files:** 39 geometry, 186 historical/wind/GPU-binding regressions, 571 selector/manager lifecycle, and 15 applicable real-v10 pond cases. Fourteen other fixture-dependent pond cases are explicitly skipped, not counted as passing. No-emit check: **767 roots / 2,571 source files / zero diagnostics**, stable 81-file pins; scoped lint passes.
- [x] Three new full-cell fits complete below the unchanged 1,000,000-work-unit cap: **982,440 / 975,866 / 979,459**. Retained clumps are **1,272 / 1,247 / 1,059** from **1,272 / 1,247 / 1,125** source placements. The last rooted-fan control retained 1,071, so do not force historical population/mask equality or conceal that difference. Actual worker/handoff checks are numerical/transport evidence, not native gameplay timing.
- [ ] Next: isolated build81 and matched full-world native comparison against165, including new roots, masks, retained populations, motion, seams and ordinary-frame timing. No rendered improvement, AAA acceptance, sustained performance or default promotion is established yet.
- [ ] Ground follow-through: retain the existing Grass004 turf, roughness, AO and color grade for the morphology comparison. If exposed turf remains overly flat, test near-field fine-detail retention using the existing samples; reject renewed grain, repetition or shimmer. Continue natural pond margins and tactile timber afterward.

References rechecked: [Grassworks](https://grassworks.techredux.co/demo) (live environment currently blocked by its HDR HTTP403), [official Three procedural terrain source](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_tsl_procedural_terrain.html), and [NVIDIA grass presentation principles](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-7-rendering-countless-blades-waving-grass) (historical guidance, not modern hardware limits). No external implementation or asset copied. Evidence: service-layout `meadow-canopy-geometry01`, `meadow-canopy-baseline01`, `meadow-canopy-integration01`, `meadow-canopy-grounding01`, `meadow-canopy-types01`, and `meadow-canopy-lint01`.

## 2026-09-23 — Flower width verified in native world; canopy and ground art next

- [x] Source checkpoint `728a512` is pushed as dreaminglucid. Fresh **build80/runtime122/native165** verifies the sole petal-width change, **1,096 unchanged compiled inputs and 145 protected artifacts**. Four saved camera views completed on Chrome/Apple M5 native Metal WebGPU at **1280×720, DPR1**, unchanged daylight, populations, textures and anisotropy16. Grass counts remain **76,189 / 59,658 / 57,289 / 79,928**; flower pools **205 / 180 / 191 / 135**. These are retained/published populations, not pixel-visible counts.
- [x] Actual authored flower buffers match the current factory byte-for-byte; placement, bounds, hinges and topology remain unchanged. Historical 0.031 buffers are source-derived, not retained native-buffer proof. Strict full terrain-shader qualification passes with the same vertex/fragment hashes as 164: **35 owned reads, 18 branch-contained rock reads, five external height reads and five PCF comparison sites**. Grass/flower whole-program equivalence remains unproven.
- [x] Two-reviewer still comparison finds **modestly fuller, clearer blossoms**, not AAA acceptance. The six-second wind clip decodes to 180 frames; six sampled frames show no obvious attachment defect, not full motion/LOD/collision approval. Coarse angular grass, bright exposed substrate, weak visual root contact, uniform pond margins and flat timber remain open.
- [x] Both historical and candidate holds yield 12 usable mixed-world-pass samples. Candidate median **10.977 ms** versus 164 **9.863 ms**; candidate 189 draws / 2,926,625 triangles versus 191 / 2,926,657. The draw difference is two fishing-glow rows, not changed flower population. Distinct builds, wind/actor state and sequential host conditions preclude causal petal-cost attribution. **No performance win, sustained 2×-resolution approval or default promotion.**
- [x] Compact receipt-v2 preserves full comparison data: an 83.12 MB historical pose round-trips exactly in 12.41 MB; native165 verifies 274 referenced files / 25,893,434 bytes. Entire capture including derived review image is 42.71 MB versus 980.75 MB for 164; this is storage accounting, not identical-content compression benchmarking. Historical evidence remains intact. All 36 timing resources were released, owned browser closed, runtime122 stopped and temporary database removed. Saved localhost:3333 returns HTTP 200; its database, services, canonical artifacts and 13 unrelated files remain unchanged.
- [ ] Next: a coherent **canopy/ground-scale and contact art pass**, informed by Grassworks and primary Three references: finer dominant blades, meaningful height variation, complementary substrate and irregular pond-edge transitions using existing habitat fields. Measure explicit geometry/density/upload/GPU budgets; no hidden resolution, population, distance or quality cuts. Tactile dock/pavilion materials follow. Traversal, night/multi-agent, sustained performance and final world-art acceptance remain open.

Evidence: private inland-pond `flower-width-native-review01.json` (SHA256 `9c3203423f4ebc8cdcd04931211e9e0500ea1c5e1333824d24c85972e3f7f99f`), native165 images/wind/raw receipts, and service-layout `flower-width-native-review01` verification log. Earlier pending entries below are historical and superseded by this result.

## 2026-09-23 — Flower readability trial implemented; native comparison pending

- [x] Broadened only the explicit two-head meadow sprig's petal-width ratio from **0.031 to 0.041**, retaining length0.068, the existing353 vertices/586 triangles, ten welded petal hinges, original single-head buffers, material and placement policy. This is an opt-in source trial, not a playable/default promotion.
- [x] **99 geometry tests and160 shared integration tests pass.** Actual Float32 checks at six representative heights, including0.12/0.8 limits and0.75 game height, retain original static bounds, head spacing, finite normals, topology, attachment metadata, complete placement matrices and clearance/rejection decisions. Convex-sector and disjoint-height-slab checks establish static petal separation, not wind-deformed collision freedom.
- [x] Reverting only the width to0.031 produces the six expected regression failures;0.041 is restored. Final no-emit check: **767 roots /2,571 source files /zero diagnostics**, stable source pins; scoped lint passes. The first type run observed a concurrent test edit and rejected its unstable pins; it was not accepted as evidence.
- [ ] Fresh build80/runtime122/native165 must compare against retained native164 at the same cameras, lighting, textures, full population and native WebGPU quality. Preserve exact-zero terrain sampling, uniform single-map shadows and strict full terrain-shader qualification. Broader petal coverage can increase raster/shadow work despite unchanged triangle counts; no cost or visual improvement is assumed.
- [ ] Future-only compact capture receipts are being qualified to eliminate repeated placement-array serialization without dropping comparison data. Historical captures remain immutable. Actual flower appearance, motion, broader grass/world art and sustained performance remain open.

References: [official Three flower-scatter source](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_instancing_scatter.html) for shared instancing and blossom variation; Grassworks remains a visual reference, not copied proprietary code. Evidence: service-layout `flower-width-geometry02`, `flower-width-integration01`, `flower-width-regression-red01`, `flower-width-types02`, and `flower-width-lint02`.

## 2026-09-23 — Uniform shadow full-world strict gate passed; art acceptance remains open

- [x] Source checkpoint `5c478bb89dd6cd4834a7579039e43451ad10e9d5` is pushed as dreaminglucid. Build79 verifies **1,097 compiled inputs: five changed existing inputs, one added helper, 1,091 unchanged**, unchanged grass configuration and all **145 protected artifacts**.
- [x] Fresh **native163/164** on build79/runtime121 completed all four full-world camera views on Chrome/native Metal WebGPU at **1280×720, DPR1, daylight0.56**, unchanged textures/anisotropy16 and full populations. Both use exact-zero rock sampling; only164 installs the actual owned `UniformDirectionalShadowNode`. Grass counts remain **76,189 / 59,658 / 57,289 / 79,928**, flower pools **205 / 180 / 191 / 135**; these are retained/published populations, not proof every member was submitted or pixel-visible.
- [x] Actual retained full terrain vertex/fragment programs now pass strict derivative-uniformity module compilation in164. The control163 retains only the known PCF strict error; no shoreline-normal error is reported in that control diagnostic. Original **35 terrain read sites, 18 branch-contained rock reads, five external height reads and five PCF comparison sites** remain. Diagnostics run after ordinary capture/timing, without changing renderer pipelines. Receiving grass/flower programs are retained but not claimed byte-equivalent.
- [x] Both unchanged12-second holds yield12 usable full-world-pass samples, **191 draws / 2,926,657 triangles**. Median GPU pass times: control **9.765 ms**, candidate **9.863 ms**. This sequential pair does not establish a speedup, exclusive shader cost or sustained performance acceptance. Ordinary six-second wind clips decode to179/180 frames respectively at1280×720; full motion/LOD acceptance remains open.
- [x] Root inspected all eight stills: no obvious gross regression, but angular grass shading, tiny scene-scale flowers, plain dock/pavilion materials and ground/shore composition still need art work. Runtime121 stopped cleanly, its temporary database was removed, both owned browsers closed, and saved localhost services/bundles were unchanged. Evidence: `uniform-shadow-native-review01.json`, native163/164 retained receipts, and `uniform-shadow-native-review01` verification log under the existing private evidence directories. The deferred absent cow model remains excluded from asset approval.
- [ ] Before another capture series, remove **serialization duplication in new receipts only**: store each full grass observation once, use hash-verified comparison references and compact process-view references, and preserve every gate and historical artifact. Current snapshots duplicate large placement arrays and consume roughly1GB/run; no historical files were deleted.
- [ ] Next art trials: validate a width-only flower change **.031→.041 with .068 length unchanged** against actual Float32 topology, original bounds, .08h hinges, clearance/placement and wind; investigate grass triangle/normal agreement using existing references. No geometry default, density, resolution or quality promotion is authorized by this diagnostic result. Traversal, seam/motion, night/multi-agent, sustained performance and AAA visual acceptance remain open.

## 2026-09-23 — Uniform shadow trial integrated; full-island capture pending

- [x] Integrated the explicit `shadowFlow=uniform-v1` island trial. Selection is captured once; malformed, duplicate and embedded routes are rejected. Omission leaves current defaults unchanged.
- [x] The real Environment owner installs the helper only for admitted compact, single-map WebGPU shadows. No-shadows quality still disables maps while retaining direct light. CSM, non-WebGPU and non-sculpt rejection preserve an existing light, its node, scene membership and construction provenance.
- [x] Quality changes and destruction release the owned target and detach only the matching map/node aliases. Real Three-object lifecycle tests cover target disposal; a rendered node can receive another idempotent dispose call from Three's own light listener, so node-event counts are not claimed as a GPU lifecycle guarantee.
- [x] **850 tests / 12 files**, including both actual headful Chrome/Metal shader gates, pass. The no-emit shared/source check has **767 roots, 2,571 source files and zero diagnostics**; scoped lint passes. Receipts: `uniform-shadow-integration-regression02`, `uniform-shadow-integration-types02`, and `uniform-shadow-integration-lint01` under service-layout evidence.
- [ ] Build79/runtime121 and fresh native163/164 will validate the complete island. Both comparison runs retain exact-zero rock sampling; only164 selects the new shadow flow. Exact source additions, unchanged geometry/population/grass config, texture owners/filtering, actual shadow-node ownership, full retained shader diagnostics and ordinary-frame timing must be checked before any promotion.
- [ ] Full-world visual, motion, traversal and sustained performance acceptance remain open. This source checkpoint does not establish a finished visual improvement or alter the saved localhost game. Next art work remains flower readability, grass form/normal quality and cohesive island finish.

## 2026-09-23 — Shoreline normal correction and native-qualified shadow candidate

- [x] Corrected pond mineral/silt normal selection to keep cotangent derivatives in uniform control flow. Original fallback normals, material values, textures and resolution remain unchanged; raw normals are shared once and sampling subgraphs retain their own branch context.
- [x] Expanded the real headful Chrome/Apple Metal WebGPU gate to include varying shoreline masks. The focused staged graph retains **35 material reads**, **18 rock reads inside one exact-zero branch**, **5 height reads outside**, and no derivative operators inside its branches. This is not the complete world material.
- [x] Added an explicit single-map shadow helper using Three's existing filter and uniform frustum selection. A real native renderer generates the complete test-scene shaders, including the actual shoreline normal functions. Strict copies of both candidate stages compile without errors; the original shadow path reproduces its nonuniform PCF failure. All **5 PCF comparisons**, radiometry, map size, bias and camera settings are retained. Strict copies are never installed into the renderer.
- [x] Same-light/same-shadow ownership checks preserve bounded fitting and vegetation LOD safeguards. Unknown, foreign, null/custom and frozen-map cases retain their existing behavior. **Environment defaults and the saved playable game are unchanged; the helper is not automatically installed.**
- [x] Verification: **838 tests / 12 files**, both explicit native GPU gates, no-emit type check (**767 roots / 2,571 source files, zero diagnostics**), and scoped lint. Evidence: `service-layout-network01-UNQUALIFIED/shader-uniformity-regression02.log`, `shader-uniformity-types02.log`, `shader-uniformity-lint01.log`; source/evidence/protection pins in `inland-pond-integration01-UNQUALIFIED/terrain-shader-uniformity-review01.json`. Earlier failed probes and type diagnostics remain recorded, not relabeled as passing.
- [ ] Next: explicitly integrate the shadow candidate into an isolated full-island build; recheck the actual retained terrain shader with strict diagnostics, exact sampling ownership, visual boundary/traversal behavior and repeated full-quality timing before default promotion. No performance win or full-island visual acceptance is inferred from these unit/native shader checks.
- [ ] Visible art remains next after this correctness gate: improve flower-head readability and evaluate actual grass-mesh normals against its folded geometry, using Grassworks and official Three references. Flower coverage, grass posture, natural banks, pavilion/dock materials and sustained smoothness are still open; AAA quality is not claimed.

Implementation references: [Three's uniform-flow implementation](https://github.com/mrdoob/three.js/pull/31531), [WGSL derivative rules](https://www.w3.org/TR/WGSL/#derivative-builtin-functions). The correction uses the installed engine API without patching dependencies, changing diagnostic policy in production, reducing filtering, or rebuilding protected canonical bundles.

## 2026-09-23 — Full-quality terrain optimization measured; strict shader correctness remains open

- [x] Source checkpoint **5721862b1** is pushed. Isolated **build78/runtime120/native161 control → native162 exact-zero candidate** completes actual Chrome/Metal capture: four matched cameras, **1280×720/DPR1**, daylight 0.56, full scene/population and all seven terrain textures at **anisotropy16**. All **1,096 source inputs, six build configurations, 18 old/new bundles and 145 canonical outputs** remain verified. No playable/default promotion.
- [x] Actual submitted candidate WGSL proves the exact **rock != 0 OR (soil != 0 AND clamp(mineral,0,1) != 0)** condition. All **18 rock sample sites** are inside one branch, all **five height reads** remain outside, and world derivatives precede the branch with the correct negative-Y convention. Both retain 35 static terrain sample sites; execution frequency is not measured. All four views and post-timing receipts retain one actual terrain shader pair per run.
- [x] Initial natural-frame world-pass medians: **19.202ms control → 9.929ms candidate**, 12 samples each. Ranges **17.433–35.717ms → 9.765–11.272ms**. Control/candidate report **189/191 draws and 2,926,625/2,926,657 triangles**; the scene remains populated but actors/wind are not phase-locked. **This is a promising single-pair diagnostic, not full-frame FPS, exclusive terrain cost, a causal percentage or sustained performance approval.** No sampler or visibility experiment precedes these holds.
- [ ] **Full-fragment strict qualification does not pass in either run.** Separate copies with derivative errors enabled report existing PCF shadow comparisons inside nonuniform frustum control flow. Existing downstream mineral/silt normal branches also contain conditional derivatives in both programs; the reported shadow error is not exhaustive. The new rock branch itself contains no derivatives. Both strict vertex copies pass. Original renderer shaders/pipelines are never replaced by diagnostic copies.
- [x] Raw vertex differences are retained: generated uniform-block declaration order and one temporary rename; executable expressions/interface and the two used object-transform uniform declarations/prefix remain unchanged. This is **not byte identity or blanket program equivalence**. Full material-boundary/pixel correctness remains an acceptance gate.
- [x] Independent eight-image comparison and root image review find **no obvious unintended material/layout regression**. Neither finds an art-quality improvement: broad angular grass/dark edges, bright exposed turf, tiny distant cream flowers, plain timber and simplified banks remain. Wind/actors/water vary between frames. Both wind clips decode to **180 frames at 1280×720**; this does not establish motion/LOD continuity. Startup **31.947s/26.718s**, slowest cuts **2.631s/2.299s**; all 16/15 host observations are AC/awake/thermal0.
- [x] Failed native157 and native159 remain failed and retained. The private checker first compared different geographic tiles selected by local allocation order; it now selects the exact spatial tile without relaxing draw/attribute checks. A later check incorrectly expected the fragment-only diagnostic directive in vertex code; strict copies now explicitly insert it there. **54 expression cases +21 copy cases**, including 10 actual saved shader programs, pass. These are helper tests, not additional rendered-quality proof.
- [x] Owned browsers and runtime120 are closed; its temporary test database is removed. Test ports are free, **localhost:3333 HTTP200**, the saved playable database and all **13 unrelated working-tree files** remain unchanged. The stale 40-day reboot warning does not require another restart.
- [ ] Next correctness/performance gate: resolve the existing shadow and conditional-normal derivative paths without reducing PCF/filtering quality; repeat controlled timing, material-boundary and continuous-camera checks before considering promotion. WGSL explicitly supports derivative-free level-zero depth comparisons; installed Three routing means merely adding `.level(0).compare()` is not a fix. A narrowly scoped uniform-flow shadow selection is another hypothesis with a measurable cost, not an implemented solution.
- [ ] Next visible art slice: improve existing flower-head area/readability within the current topology/population/flutter envelope; then isolate **actual triangle normals versus ideal parabolic fold normals** on unchanged grass geometry. Native134 already warned that stronger normal contrast exposes broad ribbons; adding gloss may simply make those ribbons shiny. Use Grassworks as visual/technique reference and official Three flower examples as source-backed guidance, not proprietary code extraction. Terrain/world finish, traversal/loading, gameplay, streaming and sustained target-resolution performance remain open.

Evidence: `terrain-rock-native-review02.json`, `native157/`, `native159/`, `native161/`, `native162/`, `runtime120/process.json` and service-layout `rock-sampling-*` receipts. References: [WGSL depth comparison](https://www.w3.org/TR/WGSL/#texturesamplecomparelevel), [Three uniform-flow discussion](https://github.com/mrdoob/three.js/pull/31531), [Grassworks appearance](https://grassworks.techredux.co/docs/grass/appearance), [official flower scatter source](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_instancing_scatter.html). Earlier sections retain historical status.

## 2026-09-23 — Exact-zero terrain sampling implemented; full-world qualification is next

- [x] Added explicit `rockSampling=exact-zero-v1`, captured once by the terrain owner. It requires the fine-meadow profile, stochastic ground/rock, height blending and pond composition; cavity-dependent coast weights are rejected. **Omission preserves the existing path; no playable/default promotion.**
- [x] Ground height and final coverage calculations remain eager. One shared deferred rock result feeds every appearance channel only when final rock weight is nonzero or dry-soil weight and clamped mineral appearance are both nonzero. There is **no epsilon cutoff**; tiny/negative nonzero inputs remain conservative. Raw coastal soil and bank-then-coast appearance order are preserved.
- [x] **768/768 tests across eight files pass**, including a real headful Chrome/Metal WebGPU code-generation test on Apple `metal-3`. The actual legacy wrapper and candidate both emit **35 static sample sites**: the candidate's **18 rock reads occupy one branch**, all **five height reads stay outside**, and all **16 derivative operators stay outside**. Shared world derivatives precede the branch; the test verifies Three.js's actual negative-Y convention. Seven texture-owner filtering policies remain unchanged at anisotropy16.
- [x] Full shared plus prior explicit grass/terrain tests: **763 roots / 2,567 source files / zero diagnostics**, stable source hashes. Scoped lint and formatting pass. Initial fixture/backend failures and the corrected derivative-sign assertion remain in the evidence logs; no simulated GPU capabilities, texture substitutions or reduced verification thresholds were used.
- [ ] **This proves generated control flow, not rendered equivalence or speed.** The native test initializes a real renderer but does not load the textures, compile a complete GPU pipeline or draw the full TerrainShader. Full bank/coastal composition, strict derivative diagnostics, zero-rock/nonzero-mineral pixels, camera travel and GPU timing still require actual game capture. No FPS, AAA, performance or quality acceptance follows from these tests.
- [x] Protection checks retain **145 canonical outputs**, the saved playable service on **localhost:3333 HTTP200**, retained lock and all **13 unrelated working-tree files**. Owned shader-test browsers and loopback servers close. No game/database restart or new reboot is required by the stale 40-day warning.
- [ ] Prepared separate build78/runtime120 admission with explicit source/report/checkpoint pins; **not launched at this checkpoint**. Next: isolated full-quality baseline/candidate capture with identical assets, geometry, population, cameras, light and anisotropy16; validate actual submitted WGSL and material boundaries before accepting any timing result. Grass coverage/contact, broader island finish, loading/traversal, sustained target-resolution performance, gameplay and streaming remain open.

Evidence: `terrain-rock-sampling-review01.json` and service-layout `rock-sampling-*` logs/receipts. Shader construction follows [Three.js explicit texture gradients](https://threejs.org/docs/pages/TextureNode.html) and [WGSL derivative rules](https://www.w3.org/TR/WGSL/#derivative-builtin-functions). Earlier sections describe their historical states.

## 2026-09-23 — Terrain sampling profiled; full-quality optimization is next

- [x] **Build77/runtime119/native156** completes actual Chrome/Metal WebGPU capture with the full scene retained: four original poses, **1280×720/DPR1**, daylight 0.56, unchanged geometry/population settings and 35 compact-terrain texture sample sites. All **1,096 compiled inputs, six build configurations, nine bundles and 84 capture pins** remain unchanged. No production source, default or playable bundle change.
- [x] At the landing camera, seven terrain textures use the public filtering update path in **16/4/4/16** order, with fixed 2-second warm-ups and 12-second natural-frame holds. Each block yields 12 valid samples. World-pass medians are **18.416 / 11.567 / 11.076 / 19.595ms**; ranges are **17.105–19.005 / 10.945–13.173 / 10.879–12.452 / 17.170–21.168ms**. Every sampled world pass retains **191 reported draws / 2,926,657 triangles**.
- [x] Read-only preflight proves one actual sampler plus one sampled-texture binding for each of the seven owners, paired to current WGSL slots. **22 terrain render objects retain their exact program/pipeline identities** throughout the comparison. The 4x native sampler creation is observed; preexisting 16x descriptors are inferred from the pinned backend cache key, not falsely presented as observed creation.
- [ ] **This is a strong filtering-sensitivity signal, not exclusive terrain cost, a causal FPS claim or shipping acceptance.** Wind/actors, cache/history and instrumentation remain confounders; GPU pass intervals overlap and must not be summed. Historical 152 program equivalence is unproven; the controlled comparison is within native156. Keep original filtering quality for production.
- [x] All seven filters return to 16 with the same GPU textures, dimensions and mip counts. Public update counters advance 1→3 intentionally; no counter rewind or cache eviction. All four timers restore and destroy their **144/144 owned query resources**, with no recorded GPU error/device loss. Camera/clock and sampler hooks restore; browser closes. Startup **31.198s**, slowest cut **2.382s**, all 28 host observations AC/awake/thermal0; wind recording decodes to 179 frames at 1280×720. These are not continuous-motion or sustained-performance approval.
- [x] Failed native153/154/155 attempts remain retained: historical generated-program mismatch, sampler-versus-sampled-texture classification, and camera-guard-versus-owned-timer conflict. The latter two are private measurement-helper defects, now exercised successfully; none produced a valid timing comparison or changed filtering. No deadlines, sample minima, scene density or resolution were relaxed to pass.
- [x] Runtime119 and its temporary database are stopped/removed. All 145 protected outputs and retained lock remain intact; **localhost:3333 HTTP200**, saved playable database/container/volume and 13 unrelated working-tree files remain preserved. The old 40-day restart warning is stale; fresh uptime is approximately 12 hours on AC.
- [ ] Next implementation: conditionally skip the **18 raw rock appearance sample sites only at exact zero final contribution**, including rock's mineral contribution to dry soil. Preserve all five height samples, final blend weights, source textures and full filtering quality. Hoist real shader derivatives outside conditional execution and verify emitted WGSL, including strict derivative checks on diagnostic baseline/candidate copies. This optimization is not implemented or measured yet. Grass coverage/contact, loading/traversal, full-world visual finish, gameplay/streaming and sustained target-resolution performance remain open.

Evidence: `terrain-sampler-native-review01.json`, `native153/` through `native156/`, `runtime119/process.json` and service-layout `terrain-sampler-*`. Next shader work follows [Three.js explicit texture gradients](https://threejs.org/docs/pages/TextureNode.html) and [WGSL derivative rules](https://www.w3.org/TR/WGSL/#derivative-builtin-functions); no third-party code or assets copied.

## 2026-09-23 — Grass color transition verified in game; modest opt-in improvement

- [x] Source **1e89efae1** is pushed under dreaminglucid. Leaf-volume now reaches its existing tip color at normalized blade parameter **0.75 instead of 1**; root0.55/tip1.12 endpoints, AO and scattering coefficients remain unchanged. The shared scattering tint changes with albedo. Unselected materials retain their previous ramp. This is not contact shading or a geometry fix.
- [x] **143 appearance/geometry/wind cases pass**, followed by **59 final appearance cases** including three new saturated/dark-tip/legacy-control cases; **590 integration cases pass**. Full shared/explicit tests: **763 roots / 2,469 source files / zero diagnostics**, stable hashes; lint/style pass. Five expected RED failures preceded the implementation. A private exact-source preflight formatting mismatch failed before build creation, was corrected without relaxing checks, and remains recorded.
- [x] **Build77/runtime118/native152** completes actual Chrome/Metal WebGPU capture at unchanged **1280×720/DPR1**, phase0.56 and full population. Exact restoration recovers build76 source; **1,095 other compiled inputs** are unchanged. Four poses retain exactly **76,189 / 59,658 / 57,289 / 79,928** clumps, the same accepted-placement attributes, source indices, mask digests/popcounts, semantic clearance and all three submitted geometry tiers. Historical root-correction bytes/per-instance Y were not retained, so byte equality is not claimed for those.
- [x] Actual submitted fragment programs differ only in the named albedo transition1→0.75; vertex programs are identical or differ only by verified declared storage identifiers. Flower counts remain **205 / 180 / 191 / 135**; geometry, density, light, wind policy and terrain sample policy are unchanged.
- [ ] **Visual verdict: incremental only.** Root and independent review see slightly better blade/turf color integration, especially close-up and beside the dock. Flat broad faces, dark reverse-face strips and bright exposed ground remain. No obvious new bleaching, color belt or gross timber intrusion appears in stills. Natural wind is not phase-locked; motion, shimmer, contact and LOD-transition quality remain unapproved. No playable/default or AAA promotion.
- [x] Twelve unique world-pass samples: **18.645ms median**, **17.236–21.758ms range**, **191 draws / 2,926,657 triangles**. This is historical cross-build diagnostic evidence, not a causal speedup, full-frame FPS or sustained acceptance; native151 had extra visibility-diagnostic warm-up. Native152 does not repeat that reduced-scene diagnostic. Timer restores and **36/36** owned query resources are destroyed, without GPU errors/device loss.
- [x] Startup **30.670s**, slowest cut **2.424s**; wind clip decodes to **179 frames at 1280×720**. All17 host samples are AC/awake/thermal0. Browser/runtime stopped and temporary database removed; all145 protected outputs, saved playable database and localhost:3333 HTTP200 remain intact.
- [ ] Next: measure terrain sampler sensitivity with the **full scene retained**, treating any temporary filtering change strictly as a diagnostic, never a shipping-quality reduction. Terrain's35 static texture sample sites and anisotropy16 are a profiling lead, not measured exclusive cost. Grass shape/ground-contact mismatch, worker deadlines, limited work headroom, traversal, sustained performance, gameplay and streaming remain open.

Evidence: `grass-rooted-fan-native-review01.json` → `leafColorTrial`, `native152/`, `runtime118/process.json`, and service-layout `grass-color-ramp-*`. Earlier sections retain their historical source state.

## 2026-09-23 — Wider fan reviewed in game; coverage and performance still unqualified

- [x] Source checkpoint **e3e421feb** is pushed under dreaminglucid. Isolated **build76/runtime117/native151** completes native Chrome/Metal WebGPU startup and all four unchanged camera gates. Exact scalar reversal restores build75 source; **1,095 other inputs and all 145 protected outputs remain unchanged**. No default/playable promotion.
- [x] All three LODs submit in every view. Positions change; normals, topology, UV/index budgets match. Arrival/meadow/flower/landing retain **114 / 128 / 125 / 133 fewer clumps**, with **2,354 / 2,618 / 2,550 / 2,692 fewer visible blades** through recomputed clearance, not lower density settings. Common accepted placement attributes match exactly; flower counts remain **205 / 180 / 191 / 135**.
- [ ] **Visual verdict: no decisive coverage improvement.** Root and independent review of all eight matched historical150/current151 stills retain conspicuous bright turf gaps, dark bases, angular straps and repeated fan silhouettes. Flowers remain readable; no obvious new gross timber intrusion appears, but stills do not prove motion clearance, attachment or continuous LOD transitions. Do not promote this recipe as AAA or solved.
- [x] Native151-only visible/hidden/visible/hidden GPU diagnostic completes **12 usable natural-frame samples per block**. World-pass medians are **18.809 / 16.318 / 18.743 / 16.155ms**; nearest-rank p95 **19.595 / 18.088 / 20.972 / 21.103ms** (with 12 samples, p95 equals maximum). Grass accounts for **25 submitted draws / 2,108,712 triangles** in visible blocks. Adjacent median differences **2.490 / 2.589ms** are marginal scene effects, not exclusive grass shader cost or full-frame FPS. Other work changes by two draws/32 triangles between pairs; natural animation, sequential order and instrumentation remain confounds.
- [x] All visibility/buffer/hook restoration checks pass; each block destroys **36/36** owned query resources, final diagnostic owner is removed, with no timer/GPU/device-loss errors. Normal 12-second full-grass hold yields 12 samples, **18.809ms median world pass**. Hidden-scene results never qualify shipping performance; tails do not establish a gain. Historical150 is not a fresh same-build timing control, especially after the extra diagnostic warm-up.
- [x] Startup **30.457s**, slowest cut **2.329s**; six-second wind video decodes to **180 frames at 1280×720**. All 28 host samples are on AC, awake and thermal state 0. Owned browser/runtime stopped; temporary database removed; saved playable database untouched, localhost:3333 HTTP200. Known deferred cow-model404 remains recorded. Another restart is not required by the stale 40-day-uptime observation.
- [ ] Next: isolate lower/mid-blade material contrast without changing geometry, density or lighting, and investigate remaining world-pass hotspots before expensive effects. This cannot substitute for coverage/contact evidence. Preserve the earlier intermittent **250.143831ms** legacy grounding failure, narrow work headroom and cold-worker failures as open reliability gates. Continuous traversal, motion, sustained frame/loading/memory, gameplay and streaming acceptance remain open.

Evidence: `grass-rooted-fan-native-review01.json` → `spreadTrial.nativeResult`, `native151/`, `runtime117/process.json`, and service-layout `grass-rooted-spread-*`. This section supersedes the pending capture/diagnostic status below; prior tests and failures remain historical.

## 2026-09-23 — Wider rooted-fan trial verified in source; native coverage pending

- [x] The sole production delta is opt-in `FINE_GRASS_ROOTED_FAN_COMPOSITION.centerRadius` **0.52 → 0.7**. No default, population, blade count/dimensions, topology, material, light, exposure, resolution or budget change. Historical non-fan geometry remains byte-checked. This supersedes the preceding test-only handoff; its RED evidence/backup remain historical.
- [x] Added independent actual-Float32 root moment/extrema and local-ring checks for all three geometry tiers and 24/12/4-blade prefixes. **94 geometry/appearance tests pass**, plus the final 21-case affected repeat. These root metrics do not establish rendered coverage, terrain fit or occlusion.
- [x] **639 integration tests pass on the unchanged rerun; 12 actual-v10 cases pass** (14 other asset-fixture cases skipped). Full shared/explicit tests: **763 roots / 2,469 source files, zero type diagnostics**, stable hashes. Scoped lint/style and whitespace checks pass; initial formatting failure was corrected without changing test semantics.
- [ ] **Retain the first integration failure as an open reliability observation:** the unchanged legacy 0.6m-coverage fixture `gcell_v1_12_11` reached **250.143831ms active CPU** against its unchanged 250ms cap. It uses no rooted-fan selector. Its isolated rerun and the full repeated suite pass; this is not proof that the intermittent deadline issue is solved or caused only by host load.
- [x] Actual-v10 candidate cells `13_17 / 12_16 / 15_17` complete at **983,211 / 975,349 / 986,712** geometric work units, leaving only **1.68% / 2.47% / 1.33%** headroom. Handoff/publication active CPU is **117.69 / 111.91 / 201.31ms**. The bank retains **1,071 clumps / 25,480 visible blades / 224 masked blades**, versus 1,082 / 25,778 / 190 in the narrower fan trial: genuine recomputed clearance, not a population reduction setting. These are CPU fixture results, not native frame-rate qualification.
- [ ] Isolated **build76/runtime117/native151** must prove the single scalar source delta against immutable build75, then compare actual views against historical native150 with matched cameras/configuration. This is a distinct-build visual comparison, not a fresh same-build timing pair. Inspect both outer coverage and central gaps, repeated fan shapes, attachment, boundary masks and LOD transitions.
- [ ] The separate bounded visibility ABAB GPU-cost helper is preparation only until actually run and reviewed. No reduced-scene result can qualify shipping performance. Prior approximately 19ms world-pass timing, cold combined-worker failures, full traversal/streaming and AAA acceptance remain open.

Evidence: service-layout `grass-rooted-spread-*` logs and `grass-rooted-fan-native-review01.json` → `spreadTrial`. Source hash `4255a13ad1ec5213530f532d6adbcc82da38942c6bbca51d1ba1a20de5fa67b8`; final test hash `6dd183ee1ef38a82f73c50d66440cf21af14fbc25639dc475606ba650d039eda`. Protected playable bundles and saved database are not promoted or replaced.

## 2026-09-23 — Restart-safe handoff; spread trial remains test-only

- [x] Completed source and native-comparison evidence are pushed through **b88dcd5b988972dbd3c6474c85595c5aa8daf6a6** on `codex/sol-duel-stream-launch`; the remote branch was checked directly. No new production rendering change is included in this handoff.
- [x] The stale 40-day-uptime restart prompt no longer describes the host: fresh uptime at 07:19 UTC is **10h18m**. Another restart is not required by that old observation. No owned capture or test is currently active.
- [x] Preserve the one unfinished grass test change in `GrassRootedFanAppearance.test.ts` (SHA-256 `d998fa97b8ae00b0be5e498397c7f79b088a64d6964f81295089f8258ae99151`). Its expected RED run, `grass-rooted-spread-red01`, ended with **7 failed / 14 passed**: tests request radius 0.7 while production remains 0.52. These failures are not a completed fix; do not commit the draft as passing code.
- [x] A separate exact Git patch is saved at `asset-studio/game-test-integration/inland-pond-integration01-UNQUALIFIED/rooted-spread-red-restart01.patch` (SHA-256 `71edff4836d348b23409c3b361d16b6c282f79696c2084cab3a8ffe8ac89ce55`); reverse-apply check confirms it matches the existing local edit. It is already applied: do not apply it again to the current worktree.
- [x] The playable server/client and saved database remain untouched. The database uses named volume `hyperia-playable-local-postgres-data`, with restart policy `no`. A normal machine restart interrupts localhost:3333 and may require restarting Docker, this same container, and the existing guarded playable launcher; verify identities first, never replace or initialize the saved database.
- [ ] Resume by testing **only fan center spread 0.52 → 0.7**, retaining all blade/density/material/lighting/resolution/work limits. Run focused geometry, integration and actual-v10 grounding tests before a new isolated build. Then review fresh native coverage, central gaps, terrain/road clearance and LOD transitions. Source-root metrics alone cannot qualify visual coverage.
- [ ] Prepare the bounded held-camera GPU visibility diagnostic separately, restoring all scene state afterward; grass-hidden measurements are diagnostic only and never shipping performance. Coverage, smooth 60fps and full-world acceptance remain open. Use the recovery guard for every Node/Bun/Blender run; do not install dependencies, materialize missing files, overwrite canonical bundles or sweep unrelated local changes into commits.

## 2026-09-23 — Rooted-fan game comparison complete; coverage regression blocks promotion

- [x] **Build75/runtime116, native149 sheath / native150 rooted-fan** complete actual Chrome/Metal WebGPU startup and all four camera gates. Both select the same close-detail layout at 1280×720/DPR1, daylight 0.56, full configured grass/flowers and 35 terrain texture reads. All 1,096 build inputs stayed pinned; only the two admitted production sources differ from build74. Source checkpoint **a250c554e** is pushed under the approved account.
- [x] All three LODs were actually submitted in every view. Topology, UV/index buffers and per-clump budgets match; fan positions/normals change as intended. Common accepted source-index XZ/rotation/scale/hash values match exactly for **75,945 / 59,426 / 57,071 / 79,641** clumps. This is not equality of rejected/raw placements or corrected root positions.
- [x] Recomputed clearance retains **338 / 353 / 336 / 392 additional clumps** at arrival/meadow/flower/landing, with **6,854 / 7,406 / 6,988 / 7,936 additional visible blades**. Corresponding cell/input counts match; acceptance and mask changes are preserved. Flowers remain **205 / 180 / 191 / 135**. A larger retained population does not prove better visible coverage.
- [x] Startup is **29.552s / 30.245s**, with 122 completed and zero failed startup grounding jobs. All four cuts finish with empty queues and zero failures; slowest cut is **2.288s / 2.485s**. These sampled successes do not establish full-island traversal, cache recovery or acceptable production loading speed.
- [x] Each unchanged 12-second landing hold yields **12 unique world-pass GPU samples**, after recording/encoding stops and with exact camera matrices matched. Median is **18.939904ms / 19.005440ms**; ranges **17.367040–19.398656ms / 17.170432–20.971520ms**. World triangles are **2,904,953 / 2,934,673**, draw calls **189 / 191**. This sequential A/B is not exclusive grass cost, causal speedup/regression proof, sustained FPS or performance acceptance. The sampled world pass alone exceeds a 60Hz frame's 16.67ms budget; smooth 60fps is not qualified.
- [x] Both ordinary six-second wind recordings complete without GPU errors or device loss and decode to **179 frames at 1280×720**. All 16 host observations per run are on AC, awake and thermal state 0. No capture error; the explicitly deferred missing cow model remains recorded. Full continuous-motion/contact approval is still open.
- [x] Root and independent review of all eight world stills find **better connected plant growth but larger exposed bright-turf pockets** in the meadow, flower close-up and pavilion approach. The landing verge is also more exposed. No obvious checkerboard, lost flower heads or major new timber intrusion appears in these stills; that is not motion-clearance proof. Broad flat strips, pointed bases and the ground/canopy mismatch remain below the target.
- [x] Both owned browsers closed; runtime116 stopped and its temporary database was removed. Protected verification passes for all 145 compiled outputs, retained lock and localhost:3333 HTTP200. Saved game data and unrelated changes remain untouched; no playable/default promotion.
- [ ] **Do not promote this exact recipe.** Preserve the connected growth while restoring a convincing, continuous meadow footprint at the existing population. Compare root distribution/plant spread explicitly; do not hide the coverage regression by darkening the whole ground or changing exposure.
- [ ] Separately test the known grass-base/material contrast, then investigate bounded canopy contact shading only if justified. Current terrain AO is texture-derived, not accepted-grass occlusion. Existing unintegrated GTAO affects indirect lighting and adds substantial passes; it is not automatically a fix for sunlit turf and has no performance approval.
- [ ] Profile the measured world-pass cost before adding expensive effects; qualify continuous movement across both LOD thresholds, dense/boundary cells, real coordinator cache invalidation/cancellation and sustained loading/frame/memory budgets. Full island, gameplay and streaming acceptance remain open. Historical native144/native146 failures and the separate cold combined-worker 250ms failure remain retained.

Evidence: `grass-rooted-fan-native-review01.json`, `isolated-build75-report.json`, `native149/`, `native150/`, `runtime116/process.json`, and service-layout `grass-rooted-fan-native149-01`, `grass-rooted-fan-native150-01`, `grass-rooted-fan-native-protected03`. Reference direction remains [Grassworks](https://grassworks.techredux.co/demo) and the inspected official rendering guidance; no third-party source/assets copied. Earlier sections retain their historical source state.

## 2026-09-23 — Rooted grass composition checkpoint; game qualification pending

- [x] Added explicit `grassGeometry=rooted-fan-v1`, admitted only with fine-meadow/leaf-volume. Four blades form each progressive fan; every shorter LOD keeps the same root prefix. Historical geometry remains byte-preserved when omitted. No default or localhost:3333 bundle promotion.
- [x] The trial changes root positions and blade directions, not population, dimensions, topology, UV/index buffers, material, wind, lighting, density, resolution or limits. Three tiers retain 24/24/12 blades and 408/216/36 triangles per clump. Receipt identity records the chosen composition; existing worker geometry transfers are exercised for all tiers.
- [x] Focused verification: **91 geometry/appearance + 639 integration + 12 actual-v10 tests pass** across eight suites; 14 unrelated asset-fixture cases are skipped. Final affected-test rerun: 18 pass. Full shared/explicit tests: **763 roots, 2,469 source files, zero type diagnostics**, stable hashes. Scoped lint/style and diff whitespace checks pass. Initial unsupported test-library API was corrected without weakening compiler settings; that failed run is retained.
- [x] Actual-v10 source placement remains identical. Two dense cells keep all 1,272/1,247 clumps; the bank retains 1,082 versus 1,044 after genuinely recomputed clearance. Fan fit/handoff/publication active time is 113.13/123.42/180.93ms, with only 1.69%/2.56%/1.77% geometric-work headroom. These are CPU fixture observations, not native scheduling or frame-performance acceptance.
- [x] Preserve the separate **cold combined-worker diagnostic failure**: both baseline and fan exceed the unchanged 250ms active limit at the bank. Source review confirms the selected production coordinator rejects that combined request and instead measures surface preparation separately before cached fitting; no fallback hides the failure. These fixture tests do not qualify the real manager/cache lifecycle or total startup cost.
- [x] Native Chrome/Metal shape study05 captured **15 images** at 1280×720/DPR1 with stable source pins, no GPU errors, owned browser/server cleanup and protected artifacts unchanged. The shared cameras moved 20% farther after study04 failed the framing margin; no geometry or resolution was changed to pass. Both attempts remain retained.
- [x] Visual review finds more coherent connected plants, but a contracted footprint, concentrated crowns and some repeated fan shapes. The neutral, shadowless study uses CPU-posed fixed wind; it does **not** establish in-game coverage, contact shadows, natural animation, LOD continuity or performance. Keep the trial opt-in and unaccepted.
- [x] Restart handoff: all owned shape-study/runtime tests have ended; runtime115 and its temporary database were already cleaned up. Fresh protected checks pass for all 145 compiled outputs, retained lock and HTTP200 on localhost:3333. The existing playable database/container/volume and unrelated local changes remain untouched.
- [x] The late restart answer concerns an old 40-day-uptime warning. A fresh check at **2026-09-23 06:42 UTC** shows **9h41m uptime** after the prior reboot. Another restart is not required by that stale observation; if the user chooses to restart, revalidate service and database identity before recovery.
- [ ] After the source checkpoint, review and finish the private **build75/runtime116** admission (future source/report pins remain unready). Then capture a fresh same-build sheath-versus-fan comparison, matched cameras/lighting/population/resolution, actual submitted buffers, retained counts/masks, natural wind and GPU timestamps.
- [ ] Qualify actual coordinator cold startup, dense/boundary traversal through both LOD thresholds, cache invalidation/cancellation, shoreline attachment and sustained performance. Coverage and contact must improve together; do not compensate by thinning vegetation or changing exposure, budgets or resolution. Full island/stream/play acceptance remains open.

Reference direction remains the inspected [Grassworks demo](https://grassworks.techredux.co/demo) and [GPUOpen procedural grass](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/); no third-party source or assets copied. Evidence: `grass-rooted-fan-native-review01.json`, `grass-blade-shape-native04/`, `grass-blade-shape-native05/` and service-layout `grass-rooted-fan-*` logs. This section supersedes earlier pending-composition wording, not historical evidence.

## 2026-09-23 — Fresh native grass comparison complete; visual finish remains open

- [x] **Build74/runtime115, native147 control / native148 candidate** complete the original startup and four camera-cut gates with stable source pins, no capture error and no host-monitor issue. Same build, 1280×720/DPR1, daylight 0.56, full configured grass/flowers and 35 terrain texture reads. Source checkpoint **938ce178** is pushed under the approved account. No playable/default promotion.
- [x] All accepted source-index arrays and per-cell clump counts match: **75,965 / 59,433 / 57,078 / 79,669** across the four views. Mask digests match every cell in the first three views and 89/90 at landing. The exception, `gcell_v1_15_16`, retains 697 clumps and changes **16,177 → 16,178** visible blades. This is one net visible blade, not proof of exactly one changed mask bit.
- [x] Candidate geometry tiers **0/1/2 are actually submitted in all four views**: per-clump **360/216/60 vertices**, **408/216/36 triangles**. Candidate tiers 1/2 preserve baseline tiers 0/1 source buffers. Geometry receipts are not GPU-deformed contact readback, equal correction values or continuous LOD-transition approval.
- [x] Both approximately six-second natural-wind recordings complete with 60 observations, unchanged camera and no captured GPU error/device loss; **180 frames each decode**. Codec checks are not continuous visual motion or temporal-aliasing acceptance.
- [x] One held landing diagnostic, 12 unique world-pass samples per run: median **17.859ms baseline / 19.005ms candidate**; triangles **2,570,681 / 2,904,985**, draw calls **189 / 191**. This pass includes other world rendering. One ordered A/B pair does not isolate grass cost, establish a causal performance delta or prove sustained frame rate.
- [x] Root and independent review: **modest close-up silhouette improvement**, less blunt bases and some smoother bends; wider views are mostly unchanged. Broad flat strips, angular joints, needle-like roots and bright exposed substrate remain. Natural wind phases differ. Visual finish is **not accepted**.
- [x] Both owned browsers closed; runtime115 stopped, temporary database removed, all 145 protected artifacts and retained lock unchanged; persistent playable database preserved and **localhost:3333 HTTP200**. The existing missing cow-model 404 remains deferred by user direction.
- [ ] Next art trial, not yet implemented: arrange the existing 24 leaves into six loose rooted fans, with prefix-stable centers across distance tiers; preserve per-blade height/width, RNG consumption and the existing vertex/index budget. Requalify normals, terrain fit, road masks and LOD transitions; reject repeated bunches or larger bare gaps. This targets plant structure, not missing grass-to-ground occlusion. No global darkening, extra density or blanket tessellation.
- [ ] Remaining gates: native continuous LOD traversal, full-island work headroom (worst sampled cell **0.89%**), smooth traversal/loading, controlled repeated target-resolution performance and gameplay/streaming stability. Startup took **29.73s / 30.20s**; some sampled cuts took about **2.4s** to settle. Passing deadlines is not seamless movement or AAA acceptance. These captures are not the requested final 2x-resolution cinematic.

Evidence: `inland-pond-integration01-UNQUALIFIED/grass-road-bounds-native-review01.json`, `native147/`, `native148/`, `runtime115/`; service-layout logs `grass-road-bounds-build74-01`, `grass-road-bounds-native147-01`, `grass-road-bounds-native148-01`, `grass-road-bounds-video147-decode01`, `grass-road-bounds-video148-decode01`. This section supersedes the pending native-comparison status below.

## 2026-09-23 — Road-bound reuse and LOD cancellation checkpoint

- [x] **Build73/runtime114** produced fresh control **native145**: four matched 1280×720/DPR1 views, full configured grass/flowers, six-second wind recording and 12 valid held-camera GPU observations. **Native146 passed startup but failed its first camera cut**, before any qualified candidate still: `gcell_v1_15_17` exhausted the unchanged geometric-work limit. Its one view row is an incomplete attempt, not a captured image; `failure.png` is failed-state evidence only. Host monitoring found no issue.
- [x] Reproduced the failure using actual v10 owners and the real pond-bank service court. The initial fixture omitted its four footing exclusions (1,127 rather than 1,125 source clumps); adding the actual court restores **1,125**, without replacing the expected count. Source-bound procgen test configuration avoids rebuilding protected installed outputs. The corrected before-fix run defers at **1,000,000 work units / 1,108 processed clumps**.
- [x] Reuse exact main-sweep per-blade XZ bounds for road admission. Every live XYZ/UV-Y check is charged; changed wind or borrowed inputs use the original full sweep. Unchanged close-detail road-hit clumps remove 720 transforms and perform 360 checks instead. Per-clump reset/completion guards prevent partial or previous-clump reuse. Fixed added scratch is at most **11,928 bytes**, allocated from the validated layout; no density, geometry, resolution, exclusion rule or work/time limit changes.
- [x] **31 new tests** cover all 15 layout/LOD combinations, independent scalar road masks, exact output/mask bytes, tangency, signed zero, live mutations and interrupted two-clump cache lifetime. Five real-worker cancellation scenarios cover the historical path and both directions across the new detail/population boundaries, including actual late grounding and placement replies, retained mesh/storage and cleanup.
- [x] Verification: **1,437 tests / 21 suites** pass before the final allocation cleanup; the final affected rerun passes **389 tests / four suites**, including all 31 new cases. Final actual-v10 run passes **nine cases** (14 other asset fixtures skipped). Full shared plus explicit tests: **762 roots / 2,468 sources, zero type diagnostics**, stable source hashes; scoped lint/style pass. Earlier fixture failures and two stale exact-work assertions remain recorded; historical goldens were not rewritten.
- [x] The corrected bank-cell pipeline completes at **991,077 work units**, **124.94ms** measured active CPU, **1,044 retained clumps / 24,782 visible blades**, with 47 partially masked clumps and 274 masked blades. The prior startup cells remain ready at **983,106 / 976,900** work units. These are CPU reconstruction results, not native frame timings or byte-exact historical worker-packet replays.
- [x] Owned browsers145/146 closed; runtime114 stopped and its temporary database was removed. Protected canonical artifacts, retained lock, persistent database and localhost:3333 are unchanged. No playable/default promotion.
- [ ] Next: newly pinned **build74/runtime115**, fresh same-build **native147 baseline / native148 candidate**, original startup/cut deadlines and full quality. Then actual screenshots, continuous wind, LOD traversal and paired GPU/frame analysis. Build73/native145 do not contain this road-bound fix.
- [ ] Work headroom is still narrow: bank **0.89%**, prior startup cells **1.69% / 2.31%**. Full-island robustness, seamless traversal, visual finish and sustained performance remain unaccepted. Existing blunt/angular roots and exposed substrate are still visible in the baseline; the candidate has no qualified in-world comparison yet. Do not declare AAA quality from passing tests.

Evidence: `inland-pond-integration01-UNQUALIFIED/native145/`, `native146/`, `runtime114/`; service-layout logs `grass-close-lod-cancellation01`, `grass-close-lod-cells01`, `grass-road-bounds-native146-red01/02/03`, `grass-road-bounds-unit01/02`, `grass-road-bounds-regression01`, `grass-road-bounds-v10-01/02`, `grass-road-bounds-types01`, `grass-road-bounds-lint01`, `grass-road-bounds-style01`. This section supersedes pending statuses in the historical checkpoints below.

## 2026-09-23 — Close-grass loading budget fix; native acceptance pending

- [x] Isolated **build72/runtime113** produced a successful fresh control, **native143**: four matched 1280×720/DPR1 views, full configured grass/flowers, a six-second wind recording and 12 valid GPU timestamp observations. This is baseline evidence, not candidate or performance acceptance.
- [x] **native144 failed** the unchanged 90-second startup gate: close-detail cells `gcell_v1_13_17` and `gcell_v1_12_16` exhausted the **1,000,000 geometric-work** ceiling in `blade_swept_bounds`. Host monitoring reported no issue. Generator resumptions (160,035 / 174,126) are not geometric work units. No qualified candidate screenshots, matched timing result or AAA approval came from this run.
- [x] Reconstructed both failing cells from actual v10 assets, retained owner meshes, source population and explicit five-segment manager geometry. Both tests failed before the fix. Historical native worker packets were not retained, so these are pinned current-source reconstructions, not byte-exact native replays.
- [x] Reuse the uncorrected root transforms already calculated for terrain fitting, only when raw XYZ still match with signed-zero-aware checks and scaled height is zero. Changed borrowed roots take the original transform path; UV correction and wind are reread. This removes **48 duplicate transforms per unchanged 24-blade clump**, with **2,304 bytes** of fixed job-local scratch. No density, geometry, clearance, resolution or work/time limit was reduced or relaxed.
- [x] All **eight applicable actual-v10 regressions pass** (14 other asset-fixture cases intentionally skipped), including real cold/cached workers, handoff, publication and cleanup. The two full pipelines retain all **1,272 / 1,247** source clumps at **983,106 / 976,900** geometric work units. Recorded active CPU times were **103.21 / 56.19 ms**, below the unchanged 250ms limit; these are not native browser/frame measurements.
- [x] **161 grounding tests pass**, including independent scalar bounds for all three tiers, signed zero, borrowed XYZ mutation fallback and fresh UV/wind reads. Independent source review found no blocking defect. The initial broader run passed **1,404** tests and found **29** stale exact work-count expectations in the historical-golden suite; that failure is retained rather than relabeled.
- [x] Final source verification: **1,433 tests / 21 suites** pass, plus **eight actual-v10 cases**; the final affected-test reruns pass **161 + eight** after fixture-typing corrections. The frozen historical goldens remain unchanged; exact work expectations deduct only the removed transforms. Full shared **761-root / 2,467-source no-emit** check has zero diagnostics and stable source hashes; scoped lint/style pass. The first type run's 21 fixture-narrowing errors are retained and corrected with explicit types/runtime attribute narrowing, not suppressions.
- [x] Both owned capture browsers closed. Runtime113 stopped, its temporary database was removed, and its protected-artifact comparison passed. All 145 canonical compiled outputs and retained lock remain unchanged; localhost:3333 still responds HTTP200. No playable/default promotion.
- [ ] The passing cells have only **1.69% / 2.31%** geometric-work headroom. Next use a newly pinned isolated build and fresh same-build control/candidate; test startup, all review cameras and traversal for other dense cells, then inspect actual GPU silhouette/contact, wind, LOD continuity and frame/GPU timings. Build72/native143 do not contain this source fix.
- [ ] Grass visual finish, full-island work headroom and native performance remain **unaccepted**. Preserve all baseline and failed evidence; do not raise deadlines or thin the meadow to obtain a pass. Continue the established Grassworks/official graphics reference direction without copying unlicensed source/assets.

Evidence: `inland-pond-integration01-UNQUALIFIED/build72/`, `native143/`, `native144/`, `runtime113/`; service-layout logs `grass-root-reuse-red01`, `grass-root-reuse-v10-02`, `grass-root-reuse-unit01`, `grass-root-reuse-regression01`, `grass-root-reuse-lint01`, final `grass-root-reuse-regression02`, `grass-root-reuse-unit02`, `grass-root-reuse-v10-03`, `grass-root-reuse-types02`, `grass-root-reuse-lint03` and `grass-root-reuse-style02`. Earlier checkpoint sections below describe their historical source state; this section supersedes their pending-run status.

## 2026-09-23 — Close-detail grass source checkpoint; native acceptance pending

- [x] Added explicit `grassGeometry=sheath-close-v1`, requiring the admitted fine-meadow/leaf-volume pair. Omission retains the historical path. Terrain captures the selection once; no default or localhost:3333 playable-build promotion.
- [x] Added three bounded tiers: close **24 blades / 5 segments / 360 vertices / 408 triangles**, middle **24 / 3 / 216 / 216**, distant **12 / 2 / 60 / 36** per clump. Middle/distant geometry bytes match the prior near/middle templates. Full placement spacing and 140m range are preserved; there is no density or resolution reduction.
- [x] The new 12m detail and existing 40m population boundaries use distance to **25m cell bounds**, not a per-blade radius, with independent 10% hysteresis and tested multi-tier camera jumps. Fresh narrower-root grounding, exact index/stride admission, masks and real worker transfers cover all three tiers; six segments remain study-only. Existing work/correction budgets stay unchanged.
- [x] All three representative shader layouts are prepared serially at startup. Independent review found teardown could otherwise submit later tiers from disposed owners: two tests reproduce the failure before the fix and now prove cancellation plus sample disposal. Actual native shader compilation remains a separate gate.
- [x] Final focused integration: **761 tests / seven suites pass**. Full shared plus explicit affected tests: **761 roots / 2,467 source files, zero type diagnostics**, stable source hashes; scoped lint passes. The final broader regression rerun passes **660 tests / 14 suites**, for **1,421 passing tests across 21 suites**.
- [x] Failure history is retained: the first manager run used the wrong manifest environment; the first wind finite-difference check crossed the sheath's C1 join with too large a step (now refined with explicit convergence and unchanged tolerances); the first integration run had a stale exact startup-field assertion; the teardown reproduction failed as expected before correction.
- [x] All 145 protected compiled outputs and the retained lock remain unchanged; localhost:3333 responds HTTP200. No isolated graphics runtime or capture was launched for this checkpoint. Existing unrelated local changes are preserved, not swept into the source commit.
- [ ] Next: root-review the prepared private capture harness, then isolated build72/runtime113, fresh same-build baseline native143 and candidate native144. Match cameras, full flowers/population, daylight and resolution; inspect root contact/silhouette, actual shader outputs, clearance, continuous wind and LOD transitions. Collect matched frame and GPU-pass timings without treating pass sums or RAF cadence as exclusive grass cost.
- [ ] No new native game capture, GPU timing or visual approval exists for this close-detail integration yet. Needle-like lower silhouette, substrate contact, density continuity and real-world performance remain unaccepted. This checkpoint is restart-safe source progress, **not AAA acceptance**; private build/capture evidence pins remain unfilled until those runs succeed.

Reference basis: [GPUOpen procedural grass](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/) informs curved geometry and derivative normals; no mesh-shader support is claimed. The previously inspected [Grassworks reference](https://grassworks.techredux.co/demo) informs silhouette/root integration only; no source or assets copied.

Evidence: service-layout logs `grass-close-integration03`, `grass-close-regression02`, `grass-close-types01`, `grass-close-lint02`, `grass-close-teardown-before01`; earlier failures and all prior native evidence remain retained.

## 2026-09-22 — Grass silhouette study: five segments favored; not enabled in-world

- [x] Added an explicit generator-only five/six-segment basal-sheath study: quarter-width roots, unchanged blade population/RNG/tips, derivative-consistent normals. Historical geometry hashes remain unchanged. No world profile, manager, worker or playable build selects the study.
- [x] **152 focused tests pass** (17 geometry, 135 existing grounding/wind/appearance); scoped lint/style and full shared **760-root / 2,466-source no-emit** check pass. The initial historical-index test mismatch is retained: source indices are Uint16, native142 captured Uint32; the corrected test checks both representations explicitly. Final source changes after lint/types were comment-only.
- [x] **grass-blade-shape-native03**: nine matched 1280×720 native Chrome/Metal montages, three variants, calm and fixed ±X wind. Real source geometry and submitted position/normal/index buffers verified; complete blade framing checked. Native01 clipped some tips, native02 failed the unchanged framing margin; native03 adjusts cameras only. All attempts retained. Owned browser/server cleaned up; protected bundles/ports unchanged.
- [x] Root and independent review favor **five segments as the next candidate**, not production acceptance: narrower bases remove the chopped-ribbon look and bends are less abrupt. Six adds little visible benefit in the small patch. Sampling and base width changed together, so the gain is not attributed to sampling alone.
- [x] Per 24-blade clump: current **216 vertices / 216 triangles / 8,208 bytes**; five **360 / 408 / 13,968**; six **432 / 504 / 16,848**. These are template/source-buffer costs, not frame timings. A blanket near-range replacement would be expensive; no density, resolution or quality setting was reduced.
- [ ] Next: qualify a bounded close-range five-segment integration, explicit layout/stride and worker admission, fresh terrain/root fitting, actual GPU wind and normals, road/bank clearance, smooth LOD transitions, then matched gameplay views and GPU/frame-time measurements. Retain existing distant geometry; do not assume a narrower root footprint preserves prior clearance.
- [ ] Needle-like lower tips, substrate contact, full meadow coverage, production lighting/SSS and continuous motion remain unaccepted. This renderer-only study uses neutral lighting and CPU-posed fixed wind; it is not an in-game, animation or performance test.

References: [Grassworks](https://grassworks.techredux.co/demo) visually inspected for silhouette/root integration; no source or assets copied. [GPUOpen procedural grass](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/) informs curve/normal reasoning, not a claim of mesh-shader support in this renderer.

Evidence: `grass-blade-shape-native03/report.json` (SHA256 `b9b29b61a4af5ba351538a7b4b3d97c44d93450095cebf52b4bf8e926d51979a`), `grass-sheath-shape-review01.json`; service-layout logs `grass-sheath-geometry02`, `grass-sheath-existing01`, `grass-sheath-types01`, `grass-sheath-lint01`, `grass-sheath-style01`, `grass-sheath-native-study03`.

## 2026-09-22 — Height-consistent grass wind verified; silhouette still unfinished

- [x] Explicit folded-layout wind now scales with authored blade height and instance scale, with a coupled normal derivative. Historical unselected layouts keep their original response. Both whole-clump terrain bounds and per-blade road sweeps use the same response; intermediate rows can extend farther than the old curve even when the tip does not.
- [x] Source verification: **698 regression tests**, **180 integration tests**, **6 current v10 pond cases** (14 other fixture cases skipped), **10 private admission checks**, scoped lint, and **760-root / 2,466-source no-emit typecheck with zero diagnostics**. The first two integration failures are retained; tests now distinguish actual Float32 geometry from ideal height and intentionally changed motion from unchanged geometry/material channels.
- [x] Native **142 / build71 / runtime112**: four matching native141 cameras, 1280×720/DPR1, daylight phase 0.56, full configured density/flowers, unchanged near/mid geometry buffers and 35 terrain texture reads. Actual submitted near/mid vertex shaders contain the new flex and normal response. The nine-bundle isolated build leaves all 145 protected compiled outputs unchanged.
- [x] Acceptance counts are recorded, not assumed identical: bank **75,947 → 75,965**, woodland **59,416 → 59,433**, flower close **57,061 → 57,078**, landing **79,650 → 79,669**. New wind bounds change some accepted clumps/masks; this is not a configured density increase. Per-cell source-index, mask digest and visible-blade deltas are retained.
- [x] A **6.002-second** natural-wind recording completed with 60 observations, no captured GPU error/device loss and an unchanged camera; all 179 encoded frames decode. Sampled frames were inspected, not continuous playback. Owned browser/server/temporary database cleaned up; persistent playable world and localhost:3333 remain unchanged and HTTP200. Existing missing cow-model 404 remains deferred.
- [ ] **Visual finish is not accepted.** Root and independent review find only a small/neutral visual change: hard segment elbows, blunt-looking bases and bright substrate gaps remain. Wider views retain fullness but show little meaningful improvement. Natural wind phases were not locked, so still differences are not causal animation proof.
- [ ] Next: isolate authored blade rest-curve and longitudinal sampling under calm and extreme wind, then address basal silhouette/contact. Do not repeat lighting/amplitude-only iterations as a substitute for correcting geometry. Native far-LOD/traversal, full motion review, GPU root-contact and performance acceptance remain open. No production/default promotion.

Reference basis: [GPUOpen procedural grass](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/) separates curved geometry, derivative normals and wind; its mesh-shader implementation is not claimed as a WebGPU feature here.

Evidence: `inland-pond-integration01-UNQUALIFIED/native142/`,
`grass-height-flex-native-review01.json`; service-layout logs
`grass-height-flex-regression01`, `grass-height-flex-integration02`,
`grass-height-flex-pond-v10-01`, `grass-height-flex-types01`,
`grass-height-flex-lint01`, `grass-height-flex-preflight01`,
`grass-height-flex-build71-01`, `grass-height-flex-native142-01`,
`grass-height-flex-video-decode01`. Source delta remains explicit and opt-in.

## 2026-09-22 — Folded grass native review: partial progress, not promotion

- [x] Built isolated build70 from the checkpoint: exactly three grass source
  differences from build69; 1,093 other inputs and all configuration unchanged.
  Eight focused harness/preflight tests passed; native capture syntax and
  independent admission review passed.
- [x] Native141 captured four matching native138 cameras on actual Chrome/Metal
  WebGPU at 1280×720/DPR1, unchanged density, flowers, daylight and terrain.
  Accepted clump counts match per cell in all four views: 75,947 / 59,416 /
  57,061 / 79,650. Current masks are stable before/after each still; historical
  mask bits were not retained, so equal counts do not establish mask equality.
- [x] Actual submitted near and mid geometry/program/storage bindings passed.
  The physical near fold is active without stacking the old cosmetic fold.
  Far LOD and traversal transitions were not exercised.
- [x] Root and independent visual review: clearer cross-leaf shading/volume,
  but broad angular bends, blunt lower cutoffs, bright exposed ground and some
  rod-like blades remain. Wider meadow improvement is modest. Keep this as an
  opt-in intermediate candidate, not a finished or default-promoted result.
- [x] Six-second natural wind clip saved; 60 observations, no captured GPU error
  or device loss. Wind phase is not matched to the baseline. Full motion/contact
  acceptance remains open; local player compatibility blocked playback review.
- [x] Owned browser, runtime111 and temporary database cleaned up; protected
  localhost:3333, persistent data, lock and 145 compiled outputs unchanged.
- [ ] Improve blade silhouette/curvature and canopy-to-ground integration
  together; lighting-only adjustments have not solved the visible defects.
- [ ] Measure the explicit +80% near-triangle cost and qualify LOD2, traversal,
  full motion/contact and wider gameplay before default/performance approval.

Evidence: `inland-pond-integration01-UNQUALIFIED/native141/`,
`grass-folded-native-review01.json`; service-layout
`grass-folded-build70-01`, `grass-folded-preflight01`,
`grass-folded-native141-01`. Source checkpoint: `7b9ee5a`.
This is native integration evidence and limited art progress, not AAA acceptance.


## 2026-09-22 — Folded grass source checkpoint; native qualification still open

- [x] Added an explicit near-only folded-lancet geometry study to the existing
  fine-meadow/leaf-volume opt-in. Ordinary and unlit/canopy-only fine profiles
  retain their geometry; mid/far ribbon geometry remains unchanged.
- [x] Preserved deterministic roots/tips and all three longitudinal intervals.
  Near blades add two ridge vertices: 7→9 vertices and 5→9 triangles per blade.
  This is an explicit +80% near-triangle cost, not a free shading improvement.
  Configured density, resolution, rendering distances and safety budgets did not change.
- [x] Coupled the new layout to full-face CPU grounding, road/wind bounds, GPU
  root/mask addressing and near-only geometry-derived normals. Shared light,
  time and player uniforms remain borrowed; the near material does not stack
  the historical cosmetic transverse fold on top of physical geometry.
- [x] 857 applicable checks passed: 698 retained-system regressions, 153 focused
  geometry/material/grounding/wind checks, and six current-v10-asset pond cases.
  Fourteen older-overlay pond cases were not enabled; no skipped test is counted.
  Shared no-emit type check: 760 roots / 2,466 sources, zero diagnostics; all nine
  changed source/test files pass lint and formatting. This is not native GPU proof.
- [x] Independent mathematical/ownership review found no new blocker. Normal
  accuracy still omits the pre-existing final per-edge root-height shear and
  smooth normals approximate the triangulated surface; neither is called perfect.
- [ ] Compile and inspect a fresh isolated native WebGPU capture against build69,
  with unchanged cameras, full density and resolution, complete population
  receipts, wind and pond-side contact. Do not claim visual acceptance yet.
- [ ] Measure the added geometry/material cost, inspect ordinary traversal/LOD,
  and address lower-canopy/pond-turf appearance before any default promotion.

Evidence: service-layout logs `grass-folded-regression01`,
`grass-folded-integration01`, `grass-folded-pond-v10-01`,
`grass-folded-types01`, `grass-folded-lint02` and `grass-folded-style01`.
The first-run rounding-test failure is retained as `grass-folded-cpu01`. The source-only checkpoint does not replace the playable
localhost:3333 bundle. The Mac already restarted; no additional reboot requested.

## 2026-09-22 — Matched terrain GPU diagnostic complete; incremental cost inconclusive

- [x] Four fresh A–B–B–A native WebGPU runs completed with 12 usable timestamp
  samples each, identical four camera poses, complete grass/flower populations,
  full density and 1280×720/DPR1. Two saved builds differ only in the exact two
  terrain files; all 1,096 current inputs and 18 bundles verified before/after.
- [x] Envelope run medians: 33.39 / 32.11 / 33.13 / 31.75 ms. Mean-of-run-medians
  change **+0.05 ms**, smaller than repeated-run variation. Terrain-containing
  mixed-pass change **+0.66 ms**, also below repeated-run variation, with
  opposite-signed directional comparisons. **Cost is inconclusive, not free.**
- [x] Raw overlapping timestamps, sample gaps, draw counts and host conditions
  retained. B2 includes two extra draw calls / 32 triangles; no hidden correction.
  No pass summation, exclusive terrain-cost, sustained FPS or significance claim.
- [x] Fourteen instrumentation/preflight tests passed; independent capture and
  analysis reviews completed. All owned browsers/runtime107–110/temp databases
  cleaned up. Normal localhost:3333, persistent data and 145 protected outputs unchanged.
- [x] Grassworks visual reference and AMD curve/normal concepts reviewed;
  documented the broad late-taper blade silhouette and coordinated geometry,
  normals and grounding constraints. No commercial code/assets imported.
- [ ] Improve blade shape/surface detail/contact and pond-side turf transition.
- [ ] Full traversal/LOD/wind, broader hardware and sustained gameplay/stream
  qualification remain open. Existing candidate stays opt-in; no production
  source, density, resolution or default change in this diagnostic checkpoint.

Report: `docs/grass-substrate-performance-20260922.md`.
Evidence: `inland-pond-integration01-UNQUALIFIED/native137–140/` and
`substrate-timing-abba01.json`; preflight/analysis logs in the service-layout
evidence directory. Mac already restarted; no further reboot is requested.

## 2026-09-22 — Calmer grass substrate retained; contact and motion remain open

- [x] Added a frequency-aware grass RGB treatment for the existing opt-in
  fine-meadow grade plus height-blended material. A 7 cm horizontal-world
  footprint preserves local color variation; 35% of the original fine detail
  remains. Original roughness, normals, AO, height, soil and rock are unchanged.
  Default/ungraded/non-height paths are unchanged.
- [x] Reuses the same seven texture assets: no down-resolution, new maps,
  density cuts, geometry changes or lighting changes. Cost is explicit:
  **33 → 35 static terrain sample sites**, two extra grass-albedo reads.
  Filtering and added arithmetic still require GPU-cost measurement.
- [x] **257/257 tests passed** across seven terrain suites. Five new actual-TSL
  tests cover footprint covariance, projection continuity, exact read counts,
  channel isolation, linear RGB composition and admission. Expanded no-emit
  check: **757 roots / 2,463 source files / zero diagnostics**; seven-file lint
  passed. Updated only affected sample-budget assertions; replaced a stale
  base-profile fixture with actual manifest identity/deep-snapshot checks.
- [x] Isolated `build69`: nine bundles, 1,096 stable input hashes; exactly
  the two terrain-material sources differ from `build68`. Chrome/Metal WebGPU
  `native136` completed four 1280×720 views, original startup gate in **30.272 s**,
  eleven nominal host samples, no capture errors. First three poses retain
  exact per-chunk grass populations **75,947 / 59,416 / 57,061**, flower
  placement/geometry and grass/flower shader behavior against `native134`
  (only strictly checked generated storage-name differences allowed).
  Actual native texture ownership confirms the added reads and unchanged
  asset hashes, formats, mip counts and sampler settings.
- [x] Root and independent visual reviews retain this as an **incremental
  opt-in improvement**, not default or AAA acceptance. Close ground is less
  yellow/green speckled while retaining fine mottling; wider views show no
  obvious regression. The fourth dock-side view is supplemental, not matched
  historical evidence; its bright, smooth shore fringe still needs art work.
- [x] Held wind recorded **6.018 s**, 59 observations; VP8 decoded cleanly,
  164 frames, three extracted frames inspected. Recorded timestamps increase
  but intervals vary **15–84 ms**. This is not full playback, game-frame timing,
  camera-motion, smoothness or performance approval.
- [x] Earlier `native135` stopped before browser launch on a historical-report
  comparison bug. Its evidence remains intact. The retry accounts only for
  the known, explicitly validated post-still optical receipt; no readiness,
  source, population, resolution or safety gate was relaxed.
- [x] Capture browser closed; `runtime106` and its temporary database stopped
  and removed. Normal localhost:3333, persistent player/database and protected
  compiled outputs remain untouched.
- [ ] Next: improve close blade shape and ground contact, and the overly bright
  pond turf fringe; do not mistake smoother texture for convincing contact.
- [ ] Before promotion: matched native GPU/frame-cost measurement of the added
  reads, grazing-angle and ordinary traversal/LOD/fade review, broader island
  art, gameplay and streaming qualification. No production-quality sign-off.

Evidence: `asset-studio/game-test-integration/inland-pond-integration01-UNQUALIFIED/native136/`
(four PNG/JSON pairs, terrain binding receipts, shaders, wind video,
`visual-review.json`); checks under
`service-layout-network01-UNQUALIFIED/grass-substrate-frequency-*`.
The immutable `native134` baseline and failed `native135` are preserved.

Research: [Three.js explicit texture gradients](https://threejs.org/docs/pages/TextureNode.html)
and [O3DE frequency separation](https://www.docs.o3de.org/docs/learning-guide/tutorials/environments/understanding-frequency-separation/).
The shader uses existing mip/aniso filtering to approximate a broadened
footprint, not an exact Gaussian kernel; no external code or assets copied.

## 2026-09-22 — Physical upper-leaf lighting retained as an incremental candidate

- [x] Tested a material-only change in `leaf-volume-v1`: upper normal weight
  `0.45 → 1`, retaining the existing `0.2` root blend and height transition.
  Upper leaves now use their deformed, folded normal instead of forcing both
  faces toward terrain-up. The default and `canopy-normal-v1` remain unchanged.
  No geometry, density, albedo, AO, scattering, shadow, texture, or resolution change.
- [x] Actual graph tests cover upper endpoints, both faces, slope, wind,
  near/full fade, antiparallel cancellation, cancelled fragment varyings and
  output passthrough. **55/55 passed**; full shared/retained-world type check:
  **751 roots, 2,457 sources, zero diagnostics**; two-file lint passed.
  These establish arithmetic and isolation, not visual continuity.
- [x] Isolated `build68`: nine bundles, 1,096 stable source inputs; only
  `GrassVisualManager.ts` differs from retained `build66`. Reversing the exact
  coefficient/comment reconstructs the previous source hash. Protected compiled
  outputs and dependency lock were not overwritten.
- [x] Real Chrome/Metal WebGPU `native134`: three matched 1280×720 views,
  original startup gate passed in **29.962 s**, ten nominal host samples,
  no capture errors/device loss. Compared with immutable `native132`,
  actual grass counts are identical per chunk: **75,947 / 59,416 / 57,061**;
  full flower populations, matrices and clearances match. Submitted WGSL
  changes only the named normal-weight coefficient, apart from strictly
  verified generated storage-identifier renaming.
- [x] Root and independent reviewer inspected all six before/after images.
  **Retain as an opt-in incremental improvement:** directional light/dark
  separation gives the meadow more depth. Close blades still look like broad
  angular ribbons, and stronger dark faces can emphasize that geometry.
  The exposed granular ground remains unresolved. This is not AAA acceptance.
- [x] Added read-only actual-light evidence: sun RGB × intensity is
  `[1.7676, 1.732248, 1.626192]`, matching the submitted uniform's Float32
  upload cache; hemisphere/ambient fill is zero with the outdoor environment
  active. World/target matrices, exposure and environment intensity are retained.
  Directional-position uniform ownership remains unclassified. The close
  receipt can lag the renderer by one completed submission; this is not an
  exact screenshot-frame light readback or retrospective lighting equality
  with `native132`.
- [x] Ordinary held wind: **6.0075 s**, 60 observations, 179 decoded VP8 frames,
  1280×720. Three extracted frames inspected. Source video timestamps are
  strictly increasing (18–49 ms intervals); the default null-output decode
  emitted timestamp-rounding warnings, retained in its log. No full playback,
  camera traversal, smoothness, fade, performance or streaming approval.
- [x] Isolated `runtime105` and its temporary database stopped/removed;
  capture browser closed. The normal playable localhost:3333 and its persistent
  database remain protected. Fresh uptime confirms the Mac already restarted;
  do not request another restart from the stale 40-day-uptime report.
- [ ] Next: coordinated grass/ground integration. The current `height-v1`
  branch uses **0.7** grass-albedo contrast, not the earlier reviewed 0.35.
  That coupling is not required by height blending. Source Grass004 contains
  dense bright fragments; correctly loaded 1024² maps, 11 mips and anisotropy16
  rule out a missing-resolution diagnosis. Evaluate frequency-aware substrate
  treatment on both covered and bare turf; do not repeat the rejected normal
  strength reduction or merely flatten all variation around one global mean.
- [ ] Still required: softer convincing close blade form, canopy-ground contact,
  ordinary camera/LOD/fade and grazing-angle review, target-hardware performance,
  gameplay and stream qualification. Do not promote this trial to defaults.

Evidence: `asset-studio/game-test-integration/inland-pond-integration01-UNQUALIFIED/native134/`
(`process.json`, three PNG/JSON pairs, `visual-review.json`,
`flower-wind-held.webm`); serialized source/type/lint/video logs under
`service-layout-network01-UNQUALIFIED/grass-physical-upper-*`.
Original `native132` baseline and rejected `native133` twist remain intact.

Research boundary: [Three's SSS material documentation](https://threejs.org/docs/pages/MeshSSSNodeMaterial.html)
describes an experimental scattering extension, not a general solution to flat
leaf lighting. [NVIDIA's vegetation chapter](https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-1-toward-photorealism-virtual-botany)
treats plant/ground lighting, variation and shadow cues together; its older
billboard implementation and performance are not a drop-in WebGPU benchmark.
No external code or assets were copied in this pass.

## 2026-09-22 — grass illumination measured; horizontal-twist trial rejected

- [x] Add a diagnostic of the actual composed grass-normal graph and existing
  thin-leaf lighting. Under hypothetical settled zenith light, interior-row
  cross-width direct-incidence spread is only 0.00055–0.01198; at phase 0.56 it
  is 0.01977–0.04794. These are CPU graph/algebra measurements, not captured
  light uniforms, raster interpolation, pixel brightness or a visual-quality pass.
- [x] Implement and test a bounded horizontal-row twist with derivative-correct
  side normals: same roots, tips, topology and GPU inputs; all 288 focused
  appearance, wind, real-worker generation and grounding tests pass. Types and
  lint pass. Near template projected area changes by about -1.2%, not zero.
- [x] Capture native133/build67 against native132/build66: three 1280x720 native
  Chrome/Metal views, original startup gate 29.842s, 122 grass cells and ten
  nominal host samples. Complete per-key grass counts match (75,947 / 59,416 /
  57,061); complete flower pools match (205 / 180 / 191). Actual submitted
  geometry buffers, native uploads and unchanged shader programs are verified.
- [x] REJECT the twist as the active visual upgrade after two independent
  before/after image reviews. Changed leaf angles do not materially improve
  naturalness or volume; broad flat ribbons and noisy exposed ground remain.
  Restore GrassVisualManager and the wind test byte-for-byte to checkpoint
  505896c. Preserve the rejected source/test patch, isolated build and captures
  under native133; keep the previously accepted two-head flowers.
- [x] Retain only the useful illumination diagnostic: 53/53 tests, zero type
  diagnostics across 751 roots / 2,457 sources, and lint pass after restoration.
  Runtime104 and capture browser closed; owned temporary database removed.
  Protected playable localhost3333, persistent database and compiled files remain.
- [ ] Next: a coordinated grass-lighting/ground-integration improvement, judged
  at close and gameplay views. Do not repeat the rejected twist, near4, pointed
  taper or blanket-root-burial trials as fixes. Grassworks and the
  [primary procedural-grass paper](https://jcgt.org/published/0004/01/02/paper-lowres.pdf)
  remain shape/ground-integration references, not proof of this game's quality.
  Existing Three thin-leaf scattering is view/light-dependent; adding that
  feature again cannot fix missing visual contrast by itself.
- [ ] AAA appearance, full motion/LOD traversal, target-hardware performance
  and streaming acceptance remain open. The 6.0075s wind recording is retained
  but not reviewed for continuous motion; its existence is not a smoothness pass.
  Evidence: native133/visual-review.json and service-layout-network01-UNQUALIFIED/
  grass-twist-* plus grass-illumination-retained* checks.

## 2026-09-22 — measured grass roots and reviewed two-head meadow sprig

- [x] Native131/build65 completed the bounded root diagnostic: 12 actual-buffer
  roots, 36 retained-triangle samples, maximum CPU height residual 3.91 micrometres.
  Sampled depths 1.210–2.066m are beyond the 0.2m near plane. Only three of five
  historical reference pixels match within the unchanged12px search tolerance.
  This is not GPU/pixel/contact proof; collector/view frames differ. No blanket burial.
- [x] Preserve native130's failed collector assertion. Stock matrix raw readWrite
  metadata compiles to read-only vertex storage; exact compiled binding/ownership
  now checked. Root-delta/visibility readOnly checks remain strict. No shader fix.
- [x] Implement explicit meadow-sprig-v1: two staggered five-petal blossoms,
  broader cupped petals, one welded branched stem/root and ten flutter hinges.
  Measured353 vertices/586 triangles versus362/584: nine fewer vertices, two more
  triangles, unchanged700/600 limits. Petal coverage can still increase fragment cost.
- [x] Keep the single-head factory default byte-identical to committed8790558
  across six heights, including normals, bounds and every attribute/index buffer.
  Only the existing opt-in flower owner selects the new0.75m sprig. No default promotion.
- [x] Pass serialized geometry87/87 and shared flower155/155 tests; full shared
  plus retained-world type check751roots/2457sources has zero diagnostics and
  stable pins. Six-file lint passes. Independent source review found no blocker.
  Tests cover welded topology, normals, hinges, all-vertex composed wind,
  both-head normal derivatives, roots, fade, bounds and exact placement transforms.
- [x] Build66: nine isolated bundles/1096source pins; only factory and flower-owner
  compile inputs differ from build65. Native132 succeeds with three1280x720
  Chrome/Metal views, startup29.254s,122/122grass cells and ten nominal host samples.
  All three poses, full205/180/191 flower populations, clearance reach, selected
  transform and unchanged grass/flower shader programs match the pinned baseline.
- [x] Inspect actual close/wide PNGs: retain fuller paired blossoms and rounder
  petal silhouettes as an incremental opt-in art improvement. Grass remains flat,
  broad and angular close up; flowers do not solve its ground/material integration.
- [x] Capture6.014s ordinary wind/60observations; VP8 decodes180frames at1280x720.
  Samples1/4/6 retain connected stems/heads. No recorded GPU errors/device loss;
  full continuous playback, animated intersections and smoothness remain unapproved.
  Raw flower-owner maximum slice2.3ms/validation2.1ms and two soft overruns retained.
- [x] Runtime103 and capture browser closed; temporary DB removed.145protected
  compiled artifacts and playable localhost3333/persistent database remain unchanged.
  Evidence: native131/QUALIFICATION.md and native132/visual-review.json, plus
  service-layout-network01-UNQUALIFIED/rooted-flower-sprig-* test receipts.
- [ ] Next: coordinated grass blade/ground appearance at close and gameplay height.
  Do not repeat rejected near4 or pointed-taper trials, bury supported roots, or
  equate stronger color contrast with physical contact. Continue primary-source
  reference review; full AAA/default/performance/streaming gates remain open.

## 2026-09-22 — grass root contrast visually reviewed; restart checkpoint

- [x] Native129/build65 completes the original Chrome/Metal WebGPU gates:
  startup 30.567 seconds, 122/122 grass cells, three saved views and ten nominal
  host samples. The three camera poses and complete flower pools match native127:
  205, 180 and 191 plants. Source/harness pins remain stable; no renderer,
  resolution, density, geometry, placement or loading-budget reduction.
- [x] Review the actual wide/close images independently. Retain root brightness
  0.55 as a modest opt-in improvement: better lower/upper separation without an
  obvious muddy-shadow regression in these stills. Grass remains broad, flat and
  angular close up; conspicuous blunt lower ends also existed in native127.
  This is not AAA, production-default, root-contact or performance acceptance.
- [x] Save six seconds of ordinary wind: 6.002 seconds, 59 observations, no
  recorded GPU errors or device loss, fixed camera and cleaned recorder/tracks.
  The 1280x720 VP8 clip decodes 179 frames. Extracted samples 1/4/6 retain attached
  heads/stems; full-video smoothness, shadows and root contact remain unapproved.
  Raw flower-owner maximum update is 2ms with two soft overruns; do not discount it.
- [x] Preserve native128's failed comparison and all historical startup failures.
  Native129's strict shader check allows only the two declared storage-name pairs;
  other bytes/bindings/types remain identical. The deferred cow-model 404 remains
  recorded, not silently treated as full asset acceptance. Review: native129/visual-review.json.
- [ ] Diagnose several actual grass roots at the close camera using bound geometry,
  instance transforms, Float32 corrections, visibility, terrain residuals and
  projected pixels. Source has finite-width root edges and a 2cm fitting tolerance;
  current receipts do not prove a gap, clipping or satisfactory visible contact.
  Do not sink all grass or change camera clipping without this evidence.
- [ ] Improve meadow composition after that check. A two-blossom sprig with five
  broader petals per head is a proposal, not implemented: retain ten flutter
  groups, existing population/bounds and at most 584 triangles, then verify actual
  topology, grounding, material wind and matched native views. Petal area can
  increase fragment cost even at identical triangle counts.
- [x] Runtime100 stopped, its temporary database removed and owned browser closed.
  No owned build/test/capture remains running. Protected 145 compiled artifacts,
  retained lock and localhost3333 checks pass; saved playable database/volume
  remain intact. Source checkpoint 755e68b retains 148 passing checks, zero type
  diagnostics and scoped lint; no production source changed in this follow-up.
- [x] The late restart reply refers to pre-reboot conditions. Fresh host check at
  18:26 EDT shows about 85 minutes uptime and about 9MB filesystem-service RSS,
  not 40 days/6GB. Another reboot is not required by that old observation. If the
  user restarts again, revalidate service/DB identity before recovery; automatic
  localhost recovery is not promised. Goal and outstanding quality gates stay open.

## 2026-09-22 — grass root-contrast candidate; visual approval pending

- [x] Isolate one opt-in leaf-volume color change: root brightness 0.78 → 0.55,
  with tip brightness 1.12 unchanged. Existing geometry, density, placements,
  normals, AO, thin-leaf model, wind, LOD and renderer settings are unchanged.
  This is authored albedo contrast, not added physical self-occlusion.
- [x] Verify 148/148 checks across appearance, wind, real-worker generation and
  flower ownership. Full shared plus explicit retained-world typecheck passes:
  751 roots / 2457 sources, zero diagnostics and stable input hashes. Scoped lint
  passes. Evidence: grass-root-contrast-source04, types02 and lint01.
- [x] Preserve source01/source02 failures (145 passed / 3 failed each). The new
  test initially missed nested TSL function nodes, then used a terrain fixture
  without its coastal meadow. Correct real-graph traversal and validated coastal
  fixture now require actual soil and bank boundary/feather/interior coverage;
  assertions were not removed. Appearance03 passes 52/52. The final suite and
  typecheck ran serially; the first suite and initial typecheck briefly overlapped.
- [x] Build65 contains nine isolated bundles and 1096 stable source pins; only
  GrassVisualManager.ts differs from build64. Protected compiled outputs unchanged.
  Native128 passes the original startup gate in 30.273 seconds with 122/122 grass
  cells and eight nominal host samples, then FAILS before its first screenshot.
  Its flower-program check rejected two generated storage-buffer identifier pairs;
  retained WGSL has identical bindings/types/calculations and fragment bytes.
  Zero completed views or wind clips; this is not a successful visual comparison.
- [x] Prepare native129's bounded identifier-only comparison: verify original raw
  shader hashes and lengths; allow bijective renaming of declared storage names
  and paired struct names only. Preserve all other bytes, bindings, member types
  and declaration order. Three valid controls pass; 16 behavioral/type/binding/
  collision/other mutations fail. See flower-storage-alpha-guard01.json.
- [x] Runtime98 and runtime99 stopped cleanly and their temporary databases were
  removed. Native128's browser closed; native129 never opened one. Protected
  localhost3333, its saved character/database and 145 compiled artifacts remain
  unchanged. No owned capture, suite, build or diagnostic runtime remains running.
- [ ] Native129 has not run: the next preflight found the actual display asleep.
  Do not synthesize input, force frames, bypass the host guard or rerun native128
  as though it passed. Compare the three native127 poses and held ordinary wind
  after the display is awake. Candidate remains unqualified and opt-in only.
- [ ] Visually decide whether the darker bases improve depth or merely muddy the
  canopy. Broad angular leaf silhouettes, uniform meadow composition and sparse
  flower accents remain open. No AAA, smooth traversal, frame-budget, streaming
  or production-default acceptance; historical loading failures remain retained.

## 2026-09-22 — post-restart matched flowers; fuller heads, meadow art still open

- [x] Recover normal localhost3333 after the Mac restarted. Reuse the exact
  persistent database/container/volume and character; preserve compiled bundles.
  Recovery02 uses installed Bun1.3.6, skips migrations and refuses replacement
  characters. The built server's existing idempotent schema assurance remains;
  this is not a claim of zero database writes. No dependencies installed or canonical bundles rebuilt.
- [x] Native126/build63 narrow baseline and native127/build64 wider-petal candidate
  both complete the unchanged gates: startup29.804/30.426 seconds,122/122 grass
  cells, three actual Chrome/Metal WebGPU views, ten nominal host samples each,
  errors[] and owned browsers closed. Reboot is an observed host-state change,
  not proof of the cause of native124 or a game-code loading fix.
- [x] Match all three camera poses and complete flower instance pools exactly:
 205 at pond arrival,180 at meadow,191 at close-up. Selected root/matrix unchanged.
  Each population remains stable through its still and the close wind recording.
  Both geometries retain362 vertices/584 triangles,512-slot capacity and32KiB
  matrix storage. Same placement/material source pins and shader receipts do not
  imply equal raster/shadow cost or GPU performance.
- [x] Record six seconds of ordinary shared wind at the close view for each run.
  Baseline/candidate durations6.010/6.006 seconds,60/58 receipt observations;
  camera, instance storage and population stay fixed, clocks advance normally,
  errors[]/gpuErrors[]/no device loss, tracks/listeners cleaned up. Candidate
  WebM decodes179 frames at1280x720. Three extracted temporal samples show
  changing grass/plant poses without an obvious detached head; this is not a
  frame-pacing, full-video motion, root-contact or long-duration acceptance.
- [x] Root and independent visual comparison retain .018h petals as an incremental
  opt-in improvement: the close head is fuller and less needle-like. Wide views
  still show tiny isolated flecks; pointed, strongly cupped petals, largely
  uniform grass shading and noisy exposed ground remain below the target.
- [ ] Root bases and individual flower shadows remain obscured. Rich mixed meadow
  composition, smooth traversal, frame/loading/memory budgets, historical grass
  failures and full island/play/stream acceptance remain open. No default promotion.
  Raw owner maximum update1.6ms in both runs; validation0.2ms and publication
  0.9/0.6ms,4/1 soft overruns remain recorded rather than discounted.
- [x] Inspect the user's [Grassworks reference](https://grassworks.techredux.co/demo)
  live: Sunny/Wind blade views and the loaded billboard variant. Finer curved
  silhouettes, stronger base-to-tip/depth variation and regional composition are
  useful art references, not measured performance parity. Read its public
  [appearance guidance](https://grassworks.techredux.co/docs/grass/appearance);
  no paid source, purchase or asset extraction.
- [x] Restore the exact tested wider-petal source after the baseline-only source
  lease. Prior194 flower tests/types/lint evidence remains tied to that hash.
  Build64 has1096 stable input pins/nine bundles. Runtime96/97 and their temporary
  databases are stopped/removed; protected145 artifacts/lock/localhost checks pass.
  Native124 and all earlier failed captures remain unchanged.

## 2026-09-22 — petal readability candidate; restart-safe checkpoint

- [x] Widen the existing procedural petal lateral profile from 0.0125h to
  0.018h. Keep flower height, placement, population, 362 vertices / 584 triangles,
  materials and the 0.08h flutter envelope unchanged. This is an opt-in art
  candidate, not a visual or performance approval; wider raster coverage may cost more.
- [x] Verify six supported heights against captured width-independent buffer
  fingerprints and analytic petal positions: 52/52 geometry cases pass.
  Placement, material, owner and resource-clearance suites pass 142/142.
  Full shared plus explicit retained-world typecheck: 750 roots, 2456 sources,
  zero diagnostics, stable inputs. Scoped two-file lint and diff checks pass.
  Evidence: `rooted-flower-petalwidth01`, `rooted-flower-petalwidth-source01`,
  `living-world-foundations-types14`, `rooted-flower-petalwidth-lint01`.
- [ ] Native124, using unchanged baseline build63, FAILS the original 90-second
  startup gate: 120/122 grass cells ready, two fitting failures, zero captured views.
  The first emitted failure is `gcell_v1_13_17`, 253.1 ms / 58957 operations
  against the unchanged 250 ms cap. The latest worker receipt records 250.0 ms
  and an 83.4 ms peak slice; do not conflate different jobs or discount their times.
  All 20 host-guard samples were nominal; historical failures remain retained.
  No successful close-up or six-second wind clip exists from this attempt.
- [x] Prepare matched two-wide/one-close views and a bounded six-second natural
  wind recorder in the private harness, without forced frames or time. Candidate
  build64/native125 has NOT run; its required baseline close/motion evidence is absent.
- [ ] Point-in-time host inspection found 40 days of uptime, filesystem event
  service near one CPU core and about 6 GiB RSS, and about 18 GiB swap use.
  These observations do not prove the loading failures are host-only. The user
  will restart after this checkpoint; no system service or other application was stopped.
- [x] Close the owned test browser, stop runtime94 and remove its temporary
  database. Protected 145 artifacts, retained lock and playable localhost3333
  checks pass. Unrelated working changes are preserved.
- [ ] After restart, establish a fresh, source-pinned narrow-petal baseline before
  the matched candidate. Preserve failed native124 without overwriting or retrying
  it under the same ID. Review actual head shape, roots, shadows and wind before
  accepting the candidate; continuous traversal/performance and richer meadow
  composition remain open.

## 2026-09-22 — exact shoreline fitting reconstruction; arithmetic trial rejected

- [x] Reconstruct native121's cell `gcell_v1_13_16` at LOD0/focus335,431 using
  the actual assets-v10 retained owners at350,450 and350,350, both resolution128.
  Pin current inputs, geometry, sources and newly measured handoff work; historical
  packet bytes were not retained, so this is not an exact historical replay.
- [x] `native121-cached-profile01`: one selected scenario passes (19 skipped),
  processing847/retaining780 clumps. Cached fitting135870 operations/107.515ms;
  measured handoff/publication completes under unchanged250ms/1M caps. The
  93-sample Node profile cannot explain the historical browser budget failure.
- [x] Reject the fade-transform arithmetic reuse trial. Four fresh A/B pairs
  preserve exact inputs, outputs,135870 operations and reservations, but candidate
  median120.597ms is slower than baseline95.312ms. All observations are retained
  in `native121-swept-ab01`; only our production edit was undone, restoring SHA
  `a4d235f47332a6c67c87aba1f4c8662a15e058f345b46e76e3e5bb8d45dba5fd`.
  No cap increase, timing discount, retry-until-green or performance-win claim.
- [x] Keep12 exact scalar/LOD/slope/scale/signed-zero/borrowed-mutation regression
  cases plus the real-cell diagnostic:582/582 tests in8 suites, typecheck750
  roots/2456 sources with zero diagnostics, and scoped lint pass.
- [x] Native123 reuses unchanged build63 after nominal-host recovery:41.624s
  startup,122/122 grass cells, two original views,12 nominal AC/awake host samples.
  Flowers205/180 with each placed population unchanged across its still; original
  camera-cut settling3.765/2.511s. Raw owner maximum update12.8ms, validation1.1ms,
  publication1.3ms and11 soft slice overruns remain visible; no performance approval.
- [ ] Root and independent visual review: somewhat easier-to-read heads, still
  sparse white flecks in dominant grass. Roots, shadows, motion, continuous
  traversal and historical three-budget/native121 failures remain open. Native122
  thermal interruption is retained. Next isolated art candidate: petal width
  0.0125h -> 0.018h with unchanged height/count/topology, verified swept bounds,
  matched wide/close views and six seconds of actual wind; not yet implemented.
- [x] Runtime93 and its owned browser/database are closed; protected145 artifacts,
  retained lock and localhost3333 remain unchanged. No source/default promotion.

## 2026-09-22 — Grassworks vegetation reference added

- [x] Review the user-supplied [Grassworks demo](https://grassworks.techredux.co/demo)
  and its public documentation as reference material. Page/docs inspection only;
  live motion/GPU comparison is pending nominal host conditions. No purchase,
  paid-source access, bundled-code extraction or performance claim.
- [ ] Compare broad coherent gusts, resting blade curvature, matte base/tip
  variation and clearly readable mixed grass/flower silhouettes in matched views.
  Keep the existing shared wind, root anchoring and conservative deformation bounds.
- [ ] Consider an authored meadow coverage/height layer while keeping exact
  retained terrain and road/water/resource exclusions authoritative. Do not
  replace them with an approximate height texture solely because a demo uses one.
- [ ] Assess near-versus-far geometry detail separately from plant population;
  do not hide regressions by cutting density/resolution. The reference's
  documented flower atlas uses billboards, not our modeled stem/petal geometry.
  See the graphics reference library for primary documentation and licensing links.


### Grassworks: specific research targets, not copied implementation

Reviewed public docs on 2026-09-22. The docs identify a Three.js 0.185.0 WebGPU
integration; that is not a reason by itself to upgrade our pinned runtime.
[Documentation overview](https://grassworks.techredux.co/docs).

1. **Motion and silhouette:** the reference exposes direction, spatial coherence,
   strength and temporal speed separately, plus resting blade curvature. Our
   follow-up is a matched held-motion review using the existing world wind:
   broad gusts shared by grass/stems/wood, smaller local petal movement, anchored
   roots and deformation-correct shadows. This is our proposed art test, not
   proof that these concepts are absent or that the vendor implementation is faster.
   [Wind](https://grassworks.techredux.co/docs/grass/wind-and-simulation),
   [blade shape](https://grassworks.techredux.co/docs/grass/blade).
2. **Readable mixed vegetation:** its atlas documentation describes flower images
   mixed with grass images in billboard geometry. Treat variety and silhouette
   as the lesson; keep our rooted near-camera flowers until any distance
   representation proves continuity, shadow fit and frame cost. More submitted
   instances alone did not make native120 a convincing meadow.
   [Atlas](https://grassworks.techredux.co/docs/grass/atlas),
   [variation](https://grassworks.techredux.co/docs/grass/variation),
   [appearance](https://grassworks.techredux.co/docs/grass/appearance).
3. **Art direction and scalability:** an authored coverage/height field could
   enrich or quiet different meadow areas without replacing deterministic keys
   or exclusion authority. The reference's terrain placement uses an overhead
   single-height capture; our retained triangle contract differs. Review both
   density and geometry detail across distance while preserving gameplay camera
   coverage, rather than blindly copying its distances or terrain mechanism.
   [Grass maps](https://grassworks.techredux.co/docs/terrain/grass-maps),
   [terrain capture](https://grassworks.techredux.co/docs/terrain/setup-and-capture),
   [LOD](https://grassworks.techredux.co/docs/performance/lod),
   [tiling](https://grassworks.techredux.co/docs/performance/tiling-and-culling).

**Access boundary:** this is a commercial product, not an open-source code donor.
Its supplied source, redistribution and AI-assisted use have license terms.
No purchase, installation or source copying was performed. Any proposed direct
integration needs an explicit licensing/access decision first.
[Product](https://grassworks.techredux.co/),
[vendor license](https://grassworks.techredux.co/license).


## 2026-09-22 — fuller meadow flowers; final native qualification remains open

- [x] Respond to the requested abundance: remove the broad patch cutoff that
  made the upper 58% of patch-noise values flowerless. Acceptance is habitat * (0.60 + 0.35 *
  (1 - patch)); retain existing positions, acceptance/yaw/scale keys, four
  candidates per cell, 484 attempts and the 512-slot / 32 KiB matrix allocation.
  Every old accepted transform is retained at unchanged geometry/inputs.
- [x] Native120/build61 density-only comparison: bank 55 -> 205 flowers and
  meadow 51 -> 180, with every old matrix retained and each captured population
  stable. Two actual Chrome/Metal WebGPU views, original startup 61.620 s,
  19 nominal AC/awake host samples and zero undeferred capture errors.
  Counts include offscreen/faded plants, not visible pixels. Both reviewers
  see more heads, but still grass with pale flecks rather than a rich meadow.
- [ ] Native120 exposes slow settling: bank 4.427 s, meadow 17.441 s; placement
  31,889 / 161,923 steps. Raw update / validation / publication maxima are
  9.8 / 1.6 / 7.4 ms, 16 soft overruns. These are NOT performance approval.
- [x] Make the opt-in owner a taller 0.75 m variety, yielding approximately
  0.638–0.863 m plants after scaling. Factory defaults remain unchanged.
  Actual height metadata, spacing/swept bounds and owner lifecycle are checked.
  Geometry stays 362 vertices / 584 triangles, but raster/shadow cost may rise.
  Larger clearance envelopes can legitimately change accepted populations.
- [x] Reduce redundant flower road checks: validate EVERY raw road first, then
  retain only road AABBs expanded by width/blend that touch the complete swept
  placement region. Exact per-flower capsule checks, retained order, all other
  exclusions, raw 4096-road cap and owner work limits are unchanged.
  Seven new cases verify all-road oracle parity, closed-boundary contact,
  800 distant segments, malformed/oversized inputs and cancellation.
- [x] Final source03: all 142 flower/material/clearance/owner tests pass;
  types12 has 750 roots / 2456 sources / zero diagnostics and stable pins;
  four-file lint03, scoped formatting and independent reviews pass.
- [ ] Final broader source03 run is **837/840, not fully passing**: three grass
  coverage/publication cases reach the active-time budget. Earlier source01/02
  passed 833/833 before the road-filter change; retain all results. The failed
  cases exercise grass fitting, not flower placement, and still need diagnosis.
- [ ] Native121/build62 fails the original 90 s startup gate: 121/122 grass
  cells, fitting 254.3 ms against 250 ms, zero comparison views. Worker peak
  interval is 73.2 ms across 64 resumes (endpoint_owner -> grounding_operation),
  including preemption, not proof of a cause. Flower owner is ready with 181
  plants. This differs from native118's surface-preparation failure.
- [ ] Native122/build63 stops when the live thermal guard observes state 1;
  zero views and no final height/filter visual or performance approval.
  Keep the abort and cascading closed-browser errors. Do not retry merely for
  a green result, relax timeouts, discount time or blame another app.
- [x] Builds61/62/63 each have nine bundles / 1096 input pins. Their changes
  are isolated to placement acceptance, owner height, then road filtering.
  Runtime90/91/92 and owned browsers are stopped; private temporary databases
  removed; protected 145 artifacts, retained lock and localhost:3333 unchanged.
  No visual default promotion or changes to the user's playable session.
- [ ] Next: diagnose cumulative grass-fitting work from the three CPU failures;
  after nominal host recovery, verify the taller denser flowers and actual
  road-work savings at the same views, then continuous traversal. Root contact,
  motion, petal detail/shadows, whole-tree wind and falling leaves remain open.

Reference: [official Three.js instancing guidance](https://threejs.org/docs/pages/InstancedMesh.html).
Shared geometry/material and bounded instancing avoid per-flower draw objects;
they do not prove that the increased population meets our GPU budget.
Evidence: inland-pond `native120/visual-review.json`, `native121/qualification-note.json`,
`native122/process.json`, runtime90–92 and build61–63 reports; service-layout
`rooted-flower-abundance-source01/02/03`, `living-world-foundations-types12`,
`rooted-flower-abundance-lint03`. Metadata erratum: native119's stale
"three-anchor" scope sentence described TWO actual views; its deferred absent
cow 404 remains in raw evidence. "Zero capture errors" excluded that deferred item.


## 2026-09-22 — surface-admission diagnostics and grouped-flower review

- [x] Add failure-only worker surface-preparation peak-slice and clock-interval
  receipts. Reuse existing clock reads and two bounded records; do not change
  yields, operation/time caps, elapsed-time accounting or failure caching.
  Strict transport validation and frozen, detached coordinator receipts preserve
  local-versus-seeded timing. Successful/cancelled responses omit timing.
- [x] Source verification: surface-admission-timing-source02 passes 122/122 tests
  across three test files; types09 checks 750 roots / 2456 sources with zero
  diagnostics and stable pins; eight-file lint02 and scoped format pass.
  The earlier types08 test-only library compatibility failure is retained and
  corrected without changing the production timing behavior.
- [x] Reconstruct the failed native118 surface at center (350,450), resolution128,
  using the actual assets-v10 manifests and production retained-terrain path.
  Pin position/index/topology bytes and source inputs. The selected real-worker
  fixture passes: 1 selected test, 18 unrelated scenarios skipped. Preparation
  uses 18,017 operations / 54.082 ms active / 2.939 ms maximum slice in this
  Node diagnostic. This is NOT replay of the lost historical packet, browser
  performance proof, or attribution of native118's 96 ms interval.
- [x] Isolated build60 has nine bundles / 1096 pinned inputs; exactly four
  production sources differ from build59, all in preparation timing/transport.
  No geometry, placement, density, grass settings or visual defaults changed.
- [x] Native119 on actual Chrome/Metal WebGPU captures the two original wide
  views at 1280x720: startup 40.592 s, grass 122/122, zero capture errors,
  unchanged 90 s startup / 30 s camera gates and 250 ms per-worker budget.
  Twelve host samples are nominal / AC / awake; another game remains active.
  Native118's failed startup remains an OPEN reliability issue, not erased by
  this successful diagnostic run.
- [x] Flower pools contain 55 / 51 instances, with 16 / 17 multi-flower cells
  and at most four per cell; each captured view retains its complete placement
  matrices. Camera settling takes 2.490 / 5.145 s. Raw owner maxima remain
  update 5.3 ms / validation 0.4 ms / publication 1.4 ms, four soft overruns.
  Projected heads are not visible-pixel counts; pools include offscreen/faded
  instances. These numbers do not establish smooth traversal or frame budgets.
- [ ] Primary and independent visual review: nearby pale heads are only subtly
  grouped; grass still dominates, with no substantial meadow-quality improvement.
  Stems/root contact, petal detail/shadows, bank approach readability, continuous
  movement, connected whole-tree wind and falling leaves remain unqualified.
- [x] Owned browser and runtime89 stopped; private temporary database removed;
  protected 145 compiled artifacts, retained lock and playable localhost:3333
  unchanged. No default promotion, streaming or quiet-host performance approval.
- [ ] Next: profile the reconstructed preparation workload and reduce measured
  validation/allocation cost while preserving every geometric check and yield.
  Separately review an actual accepted flower group up close, then in motion.

Reference: [official Three.js WebGPU instancing example](https://threejs.org/examples/webgpu_instance_mesh.html).
Shared bounded instancing remains the architecture; the example is not evidence
that our island passes performance or art acceptance.
Evidence: inland-pond `native119/process.json`, `native119/visual-review.json`,
`runtime89/process.json`, `isolated-build60-report.json`; service-layout
`surface-admission-timing-source02.json`, `surface-admission-reconstruction01`,
`surface-admission-timing-lint02.log`, `living-world-foundations-types09.log`.


## 2026-09-22 — compact flower groups: source verified, native art gate still open

- [x] Change only candidate X/Z distribution: four keyed positions per 8 m cell
  now share an irregular rotated group, with a pre-Float32 diameter at most 1.9 m.
  Patch/acceptance/yaw/scale lanes, 484 attempts, 512 slots, 0.50 m owner height,
  grass settings, cooperative yields and all terrain/resource exclusions remain.
  Accepted populations may change because habitat and exclusions use the new roots.
- [x] Verify deterministic matrices, common-cell stability, candidate key limits,
  extreme-coordinate Float32 spacing, actual factory swept-envelope separation
  and existing currentness/clearance behavior. Separation applies to supported
  factory flowers, not every arbitrary geometry accepted by the generic placer.
- [x] Source qualification: rooted-flower-cluster-source01 **833/833 tests in
  15 suites**; types07 **750 roots / 2456 sources, zero diagnostics, stable pins**;
  cluster-lint01 (11 files), scoped format and independent review pass.
  Isolated build59 has nine bundles / 1096 inputs; only placement source differs
  from build58. Protected canonical output and package installations unchanged.
- [ ] Native118/build59/runtime88 **FAILED the original 90-second startup gate**;
  no comparison views were reached. Grass was 86/122 ready, with a failed worker
  surface admission: node49, resolution128, 1,728,164 input bytes; raw worker
  270.4 ms / 2413 operations / 96 ms maximum interval, merged 273.8 ms against
  the unchanged 250 ms limit. `topology-side` is the last yielded phase, not
  proof that its sort caused the peak interval. Keep this failure as evidence.
- [x] Flower owner at that failed startup was current, ready, 49 instances and
  zero failed jobs. Raw maxima: update 3.4 ms, validation 0.9 ms, publication
  1.1 ms; nine soft-slice overruns. This is diagnostic, not frame-budget approval.
  All 19 host observations were nominal / AC / awake; another game was active.
  Do not attribute the failure to that game without evidence.
- [x] Owned browser closed, source pins unchanged, runtime88 and children stopped,
  private temporary database removed. Protected 145 artifacts / retained lock /
  playable localhost:3333 remain intact. No default visual profile promoted.
- [ ] Next: measure worker surface-admission intervals and reduce verified work /
  allocation cost without raising budgets, hiding time, skipping validation or
  treating a retry as a fix. Then capture flower groups and coherent whole-tree
  wind in actual island motion. Root contact, petal shadows, movement handoff,
  falling leaves, quiet-host performance and overall art quality remain open.

Reference: [official Three.js WebGPU instancing example](https://threejs.org/examples/webgpu_instance_mesh.html).
Bounded shared instancing remains the rendering approach; the grouping layout is
our art hypothesis, **not yet visually approved** and not a claim from that demo.
Evidence: `inland-pond-integration01-UNQUALIFIED/native118/process.json`,
`runtime88/process.json`, `isolated-build59-report.json`, and
`service-layout-network01-UNQUALIFIED/rooted-flower-cluster-source01.json`.


## 2026-09-22 checkpoint — flower scale in the actual grass canopy

- [x] Native116/build57 captures two close views of an EXISTING accepted island
  flower. Its stored root is identical to native115; the same matrix remains
  unchanged across both close views. Actual retained terrain lies below each
  camera with the original near plane. Low angle resolves a connected stem,
  cream petals and yellow center; oblique grass conceals most of the head.
  Concealed roots and these stills do not qualify contact, animation or shadows.
- [x] Raise only the opt-in meadow owner's authored flower height from 0.38 to
  0.50 m (instance variation gives about 0.425–0.575 m). Factory defaults,
  material, grass, density, hash lanes, capacity and work allowances stay intact.
  Actual geometry remains 362 vertices / 584 triangles with Uint32 indices;
  full-height metadata and bounds are checked. Larger flowers still increase
  swept clearance/raster coverage; unchanged topology is NOT equal GPU cost.
- [x] Source regression: 829/829 tests in 15 suites, full shared/explicit typing
  750 roots / 2,456 sources / zero diagnostics with stable pins; scoped 11-file
  lint and two-file formatting pass. Build58 has nine bundles / 1,096 inputs;
  its only changed compiled source versus build57 is RootedFlowerVisualManager.
- [x] Native117/build58 captures the same two close poses plus the established
  eastern meadow view on real Chrome/Metal WebGPU. Exact target root, rotation
  and scale match native116. Target authored world height is 0.483287 m before
  deformation; captured pool counts are 52 / 52 / 53. Original startup passes
  in 44.637 s; flower cut-readiness takes 3.689 / 0.326 / 4.815 s within original
  allowances. Zero capture errors, stable pins and 13 nominal AC/awake samples.
  These settling times are not seamless movement or reliable-startup proof.
- [x] Primary and independent art review retain 0.50 as an INCREMENTAL candidate:
  plausible proportions and a higher head in the low view. Oblique occlusion
  persists and the meadow still reads as isolated pale specks. Natural wind is
  not phase-matched, so pixel differences are not isolated height attribution.
  Visibility, root fitting, petal self-shadow and overall art are NOT solved.
- Raw native117 owner lifetime maxima: update 11.500 ms, validation 0.500 ms,
  publication 0.900 ms; 13 soft-slice overruns by the final view. These include
  neither all observer costs nor isolated frame/GPU cost. No quiet-host or
  performance approval; the user's other game may remain active.
- [ ] Next high-value art change: compact irregular groups using the EXISTING
  four attempts per 8 m cell. Current shared 24 m habitat gates still scatter
  roots over 6.5 m squares. Change only keyed X/Z offsets, retaining acceptance,
  yaw/scale hashes, caps and every terrain/road/water/resource check. Verify
  cell/horizon invariance, group radius/separation and actual resulting counts;
  do not blanket-increase density or clear grass around test flowers.
- [x] Runtime86/87, owned browsers and temporary DBs stopped; protected 145
  compiled artifacts, retained lock and playable localhost3333 unchanged.
  No default promotion. Continuous movement, connected tree-wind acceptance,
  falling leaves, sustained performance and whole-island AAA quality remain open.

Evidence: inland-pond `native116/117/process.json`, PNG/view receipts and
`visual-review.json`; `isolated-build58-report.json`; service-layout
`rooted-flower-height-source01`, `rooted-flower-height-lint01`,
`living-world-foundations-types06`. Official instancing, bounds and shared
shadow-position references from the preceding checkpoints remain applicable.

## 2026-09-22 checkpoint — actual island flower integration, art still open

- [x] Source-bind the flower owner in private build57 without rebuilding protected
  packages. Nine bundles / 1,096 input pins are verified. The flattened private
  build resolves its existing Delaunator dependency from the installed procgen
  package; no install, canonical dependency or lock change. Build55 was not run;
  runtime84/build56's missing-dependency failure is retained, not concealed.
- [x] Native115/runtime85 renders the actual TerrainSystem flower owner in headed
  Chrome/Metal at the unchanged 1280×720 profile. Original startup passes in
  33.838 s with 122 completed / zero failed grass cells. Pond-arrival and eastern
  foliage camera cuts satisfy the original 30 s allowance: flower readiness at
  1.996 / 4.454 s respectively. These are diagnostic settling times, NOT seamless
  camera-motion acceptance, isolated feature cost or evidence of a speedup.
- [x] Actual submitted native flower pipelines and one 32,768-byte matrix-storage
  allocation are observed. The two published pools contain 58 / 53 instances;
  9 / 7 static projected heads do NOT imply that many unoccluded visible flowers.
  Main-view ownership, source/served-response hashes and before/after storage
  identity/version checks pass. Zero capture errors; all nine host checks nominal,
  AC-powered and awake. Other-game activity excludes quiet-host qualification.
- [x] Retain native114: original startup passed in 45.810 s and flowers were ready,
  but delayed retrieval of the original framework response failed in the capture
  harness. Native115 hashes that original response promptly instead of refetching;
  no production threshold, rendering setting or startup budget was relaxed.
- Actual owner lifetime maxima in native115: generation/update 3.100 ms,
  validation 0.200 ms, publication 2.300 ms, three soft-slice overruns. Native114
  retains its larger 6.400 ms update maximum and six overruns. Validation telemetry
  excludes getReceipt's repeated live check and other preparation work; these
  values are not total frame/GPU cost or a claim that the owner stays below 1 ms.
- [x] Primary and independent image review agree: a few pale flower heads are
  visible, but dense grass dominates and most flowers read as tiny flecks. No
  meadow-art approval. Concealed roots and distant petals cannot establish
  complete fitting, self-shadow quality or wind animation.
- [ ] Next: close, low-angle native island review of an EXISTING accepted flower,
  keeping density, grass, lighting and renderer settings unchanged. Then tune
  height/shape, grouping and contrast from evidence, without blanketing the field.
- [ ] Test continuous movement and population replacement. Measure steady owner
  distributions on a quiet host. A bounded allocation optimization may compare
  live resource scalars against captured IDs while preserving the full scan,
  duplicate detection, region/depletion semantics and replacement checks; do not
  replace currentness with incomplete entity events or Map-size caching.
- [x] Owned native browsers and runtime85 are stopped; its temporary DB removed.
  Protected 145 compiled artifacts/retained lock/playable localhost remain intact.
  Defaults are unchanged. Connected tree wind, falling leaves, petal self-shadow,
  reliable startup, sustained performance, 2× cinematic and AAA acceptance remain open.

References remain the [official WebGPU instancing example](https://threejs.org/examples/webgpu_instance_mesh.html)
and [instance updates, bounds and disposal](https://threejs.org/docs/pages/InstancedMesh.html),
checked against local r186. Evidence: inland-pond `isolated-build57-report.json`,
`rooted-flower-build57-preflight01.json`, `native114/process.json`,
`native115/process.json`, two native115 PNG/view receipts and
`native115/visual-review.json`, `runtime84/85/process.json`.

## 2026-09-22 checkpoint — opt-in rooted flower placement and ownership

- [x] Add an explicit `flowers=rooted-v1` candidate, admitted only with the
  fine-meadow appearance/profile pair. Omission preserves the existing world;
  no grass placement, RNG, geometry, worker allowance or default is changed.
- [x] Wire one exclusive 512-slot storage pool into TerrainSystem. Deterministic
  8 m cells produce at most 484 candidates around the primary view, with sparse
  patch eligibility and separate bounded work. Roots sample actual retained
  triangles, never procedural height. Shared-border owners must agree at the
  stored Float32 height; cracks/overlaps/missing terrain cannot report ready.
- [x] Require full swept horizontal clearance from roads, pads, exclusions,
  water, and live tree/ore approach reservations. Region-scoped resource
  snapshots keep depleted/regrowing clearance stable and ignore unrelated
  far-away edits, but detect entrants and same-ID owner replacements.
- [x] Retire stale publication before the main render; cancel old input iterators;
  re-ground after terrain/water changes; retain only per-world wind uniforms;
  recompute and expand instance bounds. Camera cuts cannot report readiness for
  an old cell. Primary-focus 24–32 m shrink is root-preserving and shared by the
  main/shadow graph; no transparency, separate shadow-camera fade or matrix churn.
- [x] Serialized source regression `rooted-flower-placement-source03` passes
  **829/829 tests in 15 suites**. Includes real generated terrain/World/resource
  objects, independent ray intersections, cancellation, ownership, terrain
  arrival, resource changes, graph deformation and existing grass/tree behavior.
  These CPU checks are not a native game, visual or performance acceptance.
- [x] Full no-emit shared/explicit type check: 750 roots / 2,456 source files,
  zero diagnostics, stable pins (`living-world-foundations-types05`).
  Scoped 11-file lint/format and independent lifecycle/bounds review pass.
- [x] Native Apple/Metal WebGPU `rooted-flower-native07` passes nine matched
  768² captures: near/partial flowers and receiver shadows remain visible; far
  casting and noncasting frames match the empty background byte-for-byte.
  Both passes bind the same owned primary-focus node and retain two read-only
  matrix declarations sharing one allocation. Seven flower buffers retire once;
  zero GPU/cleanup errors and stable source pins. This isolated shader check is
  NOT native owner/island integration, performance or art acceptance.
- [x] Retain failed native06: its expected camera projection was captured before
  WebGPU initialization, although all nine rendered camera receipts agreed.
  The fixture now initializes both owned cameras' WebGPU projection before the
  unchanged exact comparison. No production shader, budget or shadow setting
  was changed to obtain native07. Source01's two fixture failures also remain.
- [x] Stop private preview06 and close owned Chrome/HTTP resources. Protected
  145 compiled artifacts and retained lock are unchanged; localhost3333 HTTP200.
  No game/DB restart, canonical build, dependency install or default promotion.
- [ ] Qualify the actual island owner in a fresh isolated source-bound build,
  including resource density, startup, moving-camera handoff and all steady-frame
  costs. The 1 ms generation slice is soft and records overruns; it does NOT cover
  synchronous resource/terrain validation or promise a total 1 ms owner cost.
  Full resource rescans remain allocation-heavy and require measurement.
  Root centers are fitted; upright root rings are not individually slope-fitted.
- [ ] Resolve the previously observed petal self-shadow striping; review flowers
  at real meadow scale and improve art if needed. Falling leaves, native grass
  scalar-optimization verification, native110 startup failure, sustained
  performance and the requested 2× cinematic remain open. No AAA/default approval.

Implementation follows the [official WebGPU instancing example](https://threejs.org/examples/webgpu_instance_mesh.html)
and [explicit instance-bound/update responsibilities](https://threejs.org/docs/pages/InstancedMesh.html).
The [r186 renderer's shared shadow-position contract](https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/common/Renderer.js)
is used instead of updating visibility from a shadow camera.

## 2026-09-22 checkpoint — bounded petal flutter and live resource clearance

- [x] Rooted flower shader composes a small quadratic petal shear before stem
  bending, using the borrowed per-world wind nodes and existing instance buffer.
  Shared hinges have zero flutter value/slope; both stages correct normals.
  Combined bounds now explicitly include X/Y/Z and sphere expansion.
- [x] Serialized material/tree-wind regression: **105/105** cases pass
  (`rooted-flower-material03`), including real native graph arithmetic,
  finite-difference normals, scaled vertex/triangle bounds and malformed hinges.
- [x] Native Apple/Metal WebGPU `rooted-flower-native04` and `05` PASS:
  13 and 15 actual 768² captures respectively, including flower-head close-ups.
  Both main and shadow passes consume petal metadata. Each retains two read-only
  matrix declarations sharing one GPU allocation; seven submitted flower buffers
  retire exactly once. No GPU/cleanup errors; source pins and input arrays stable.
  These are isolated rendering diagnostics, not island/performance acceptance.
- [x] Inactive `FlowerResourceClearance` reads actual client ResourceEntity actors,
  including network-only trees/ore. It retains depleted/regrowth reservations,
  conservatively encloses occupied/cardinal approach tiles plus flower reach,
  and reserves the maximum supported footprint when client metadata is absent.
  Detached snapshots re-scan membership, live transforms and actor identity before
  publication; caps are 4,096 scanned entities / 512 obstacles and fail closed.
  **29/29** actual World/ResourceEntity CPU tests pass (`flower-resource-clearance01`).
- [x] Full shared + explicit source/test types: 746 roots / 2,429 source files,
  zero diagnostics and stable pins (`living-world-foundations-types04`).
  Scoped lint/format and independent read-only reviews pass.
- [ ] **Visual quality still open:** macro casting-on/off comparison in native05
  removes the harsh petal striping when casting is off (19,288 affected foreground
  pixels). This identifies self-shadow contribution in the isolated light setup,
  not an approved solution. Do not promote a no-shadow default or change global
  island bias/map budgets from this fixture. Review silhouette, color, normals,
  self-shadow policy and actual island-scale appearance together.
- [ ] Integrate sparse deterministic patches with actual retained triangles and
  fresh terrain/road/water/exclusion leases, full wind reach, bounded scheduling,
  distance transitions and chunk retirement. Resource snapshots are not lifetime
  subscriptions: later additions/relocations still require owner revalidation.
  Existing disabled billboard flowers remain disabled; no new world default.
- [ ] Falling leaves, integrated meadow visual/cost approval, and native grass
  scalar-optimization verification remain open. The earlier native110 startup
  failure is not resolved by these flower checks. Final performance needs a
  quiet host window; concurrent gaming is acceptable for source work.
- [x] Private preview runtimes04/05 stopped and their Chrome/HTTP owners closed.
  Protected 145 compiled artifacts/retained lock remain unchanged; localhost3333
  still returns HTTP200. No game server/DB restart, install, or canonical build.

Applied official r186 contracts: shared visible/shadow deformation and native
instance ordering ([NodeMaterial](https://raw.githubusercontent.com/mrdoob/three.js/r186/src/materials/nodes/NodeMaterial.js),
[Renderer](https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/common/Renderer.js)),
explicit animated bounds ([InstancedMesh](https://raw.githubusercontent.com/mrdoob/three.js/r186/src/objects/InstancedMesh.js)),
and static matrix ownership instead of copying the per-frame uploads in the
[official instancing example](https://threejs.org/examples/webgpu_instance_mesh.html).

## Texture-quality priority — shoreline repetition remains open

## Plural service foundation — source checkpoint, not layout acceptance

The opt-in `compactServiceCourts` contract now admits a bounded, ID-addressed
set of bank/smithy pavilions. Actual owners, physics, visual leases and streaming
readiness enumerate the same descriptors; a missing outlying bank fails bank
readiness even when the primary is healthy. Station/NPC bindings are mandatory,
and explicit primary-bank path selection preserves historical ground paint.
Grass exclusion capacity is bounded at 64 polygons; this is not a cost approval.

Post-recovery verification passes 66 owner/visual/path, 41 surface-snapshot,
28 actual emitted-worker, one bank-event identity and 21 client-regression
tests. Strict test-inclusive source typing, client typing and scoped lint/
formatting pass. No new native browser or multi-agent performance acceptance
is claimed. All 145 protected compiled artifacts remain unchanged.

**LAYOUT-01–08 remain open.** No new layout is promoted: outlying journey/path
design, shared-bank custody/retry/restart verification, natural inland pond,
mines, trees, quest NPCs, dispersed altars and whole-island art remain to be
implemented or qualified. Bank-event identity coverage is not a live network
deposit/withdrawal proof. See `development-checkpoint-20260920.md` and local
`service-layout-network01-UNQUALIFIED/` evidence for scope and recovery limits.

## Inland pond and fishing — source checkpoint, placement still open

The pond must support all seven fishing families and all 12 fish, with two
distinct dock designs and non-dock access for every tier (LAYOUT-07 below).
The checked-in, non-runtime basin study at (410,415) samples approximately
42 × 37 metres of water and 119 metres of irregular shoreline; these are CPU
terrain measurements, not approved fishing capacity or in-game visual evidence.
Compact elevated water now follows sampled canonical ground with a fixed 0.5m
mesh and real shore-distance data. Its 17 actual-class tests and 102 stock
water/terrain regressions pass; native appearance, indexed/PhysX agreement,
frame cost and the full relocated habitat remain unqualified. The three
art03 coarse-assembly failures are now resolved: tests use the production local
detail regions, and impossible mirrored-only remote annular refinement is
rejected without weakening direct-intersection geometry caps. Art03 passes
150/150 terrain/water cases; stock passes 149 with one candidate-only skip.
The opt-in dock foundation now shares fitted approach/deck triangles, sampled
support feet and authored rail openings across drawing and movement/physics.
Two CPU-tested placements fit the candidate basin; native integrated art,
fishing capacity, complete routes and frame cost remain open acceptance gates.
No pond, fishing spot, dock or supplier has been relocated in the live manifest.

### Grass matrix follow-up — correctness verified, performance still open

Both actual grass constructors now use privately owned, versioned matrix
storage. Placement, density, geometry, wind, grounding, shadows, culling,
resolution and the 30-second transition gate are unchanged. Four real-class
suites pass 112/112 tests; source-only 725-root typing, scoped lint and
formatting pass. Build06 preserves all 145 protected compiled artifacts.

The actual Apple Metal grass fixture passes exact ordinary/storage pixel
comparisons at both active LODs and two wind phases, including received
occluder shadows and a translated/rotated parent. It proves zero unchanged
matrix uploads, native binding limits and destruction of root, visibility and
matrix allocations. This is a correctness fixture, not approved meadow art.

Native09 confirms all 65 observed grounded chunks own the expected storage
matrix, but still fails the unchanged pond transition. Native10 also fails.
No FPS improvement or sustained performance acceptance is claimed. Native11
proves the timestamp attribution defect: all 1,290 observed framebuffer-copy
resumes overwrite another pass's query slots. Its observation is complete,
with no counter overflow; the view deadline still fails. Treat native10/11
per-pass durations as invalid for cost attribution, not as exclusive costs.
This diagnostic defect does not itself explain normal rendering performance.
Renderer-accounted texture
memory is about 2.04 GiB, requiring an actual owner/allocation census before
choosing further optimizations. Keep vegetation changes separately scoped.

LAYOUT-01–08 remain open. Candidate route/custody separation, concurrent fishing
and finished pond views are not approved. Receipts:
`inland-pond-integration01-UNQUALIFIED/grass-storage-native01/`,
`native09/`, `native10/`, `native11/`, and `isolated-build06-report.json`; CPU receipts
are `service-layout-network01-UNQUALIFIED/grass-storage-*`.

### Static color-texture reuse — verified memory saving, performance still open

Parsed static PBR VRMs now reuse an exact matching ImageBitmap color texture
within each source material. Per-instance materials remain independent.
Unknown/dynamic metadata, real texture-transform payloads, custom callbacks
and unequal texture state retain separate views. All material setup callbacks
finish before aliasing. The VRM loader's injected optional transform declaration
is allowed only when no actual transform payload exists; required transforms
still veto reuse. No texture is resized, no mip is removed, and no borrowed
texture or ImageBitmap is disposed by this optimization.

The final three-suite gate passes 53/53 tests; 726-root source typing, scoped
lint and formatting pass. Build09 produces eight isolated bundles from 973
inputs, preserving all 145 protected compiled artifacts. Actual Chrome/Metal
fixture04 proves exactly equal day/night/shadow pixels, native color allocations
2→1 at 2048² with 12 mips, independent sibling materials and safe sibling removal.
Ten negative browser cases cover unsafe state, dynamic metadata and setup order.
Initial fixture failures exposed the loader-injected declaration; those failed
receipts remain retained rather than being counted as passes.

Native15 records 310 creations/two destroys versus native14's 325/two, with
known live payload 1,811,188,226 versus 2,146,732,526 bytes: 335,544,300 bytes
(about 320 MiB) less. Six depth-format footprints remain unknown, and bounded
owner/node attribution overflows; these are not physical-residency measurements.
The matched 15 NPC/mob texture groups cover the same 35 character instances:
each pair becomes one native allocation, retaining both material slots and all
30 captured texture-state fields. Non-character live allocation descriptors
also match exactly. Cross-run ImageBitmap object IDs are not pixel hashes.
The unchanged 30-second pond transition still fails, with four grounding jobs
and one LOD swap in its final settling observation. No FPS improvement, final
pond art, full stream or concurrent-fishing acceptance is claimed.

All owned browsers and runtime07/08 disposable databases are closed; human
localhost and protected outputs remain unchanged. LAYOUT-01–08 remain open,
including fourteen simultaneous anglers, two distinct docks and shore access.
Evidence: `inland-pond-integration01-UNQUALIFIED/avatar-texture-native04/`,
`native15/`, `avatar-texture-census-comparison.json` and
`isolated-build09-report.json`. CPU receipts in
`service-layout-network01-UNQUALIFIED/` are `avatar-texture-tests03.log`,
`avatar-texture-types03.log`, `avatar-texture-lint03.log` and
`avatar-texture-format03.log`.

### Shared-budget grass handoff — native captures, not art acceptance

Native17 observed 34 empty completions taking separate frames despite pending
work. Their active slices totalled 11.8ms; the unused nominal allowance is an
upper bound, not a promised speedup. The manager now hands validated empty
completion to the next nearest job using the same absolute 2ms deadline and
remaining 8,192-operation allowance. Nonempty publication still stops the call;
failure, waiting and cancellation do not spin. No appearance or shader changed.

The source passes 189 tests (one opt-in diagnostic skipped), 727-root typing,
scoped lint and formatting. Fresh build10 leaves 145 protected artifacts intact.
Native18 captures all three views within the unchanged 30-second gate:
28.02s overview, 11.29s landing and 3.89s jetty. Its complete ledger records
1,278 manager calls, 125 completed jobs and eight same-budget handoffs, with
at most 8,192 aggregate operations and one nonempty publication per call.
All eight handoff calls measured at most 2ms, but a single-continuation call
reached 38.6ms. The deadline is cooperative, not a hard wall-time guarantee;
sustained smoothness and allocation/scheduling pauses remain open.

All three views contain 14 real fishing entities, two per family; this is not
fourteen concurrent anglers. Root visual review rejects final art acceptance:
the pond still reads too oval, banks too uniform and dock timber too repetitive.
Natural coves, varied habitat, stronger dock character, dry routes, custody,
actual concurrent fishing and the complete island composition still need work.
All LAYOUT-01–08 gates remain open. No human localhost/default promotion.

Evidence: `inland-pond-integration01-UNQUALIFIED/native16–18/`, including
`native18/grass-budget-ledger.json` and all three PNGs; CPU receipts are
`service-layout-network01-UNQUALIFIED/grass-empty-handoff-*`.
Native18 observers restored, inputs remained pinned and the owned browser closed.
The console retains 41 unattributed HTTP503 errors and five known missing-model
404/load errors; a clean observer receipt is not an error-free-runtime claim.
Private runtime10/11 and disposable databases are closed; human services,
database and protected outputs are unchanged.

### Native texture census — diagnosis before implementation

Native12 confirms that the pond's two depth captures surround an actual
depth-writing back-face draw. Removing a capture is not established as
pixel-equivalent. Native13 uses unique timestamp pairs for all actual passes:
29 sampled frames, no GPU errors and 87/87 diagnostic resources destroyed.
Overlapping vertex-to-fragment stage intervals still cannot be interpreted
as exclusive pass costs. The unchanged pond transition deadline fails.

The pre-boot native texture census observes 325 allocations and two explicit
destroys. Known live texel payload is 2,146,732,526 bytes, plus six unknown
depth-format footprints; this is not physical resident memory. Seventy-seven
2048-square full-mip textures account for 1,722,460,740 bytes. Native allocation
counters do not overflow, but bounded owner/node attribution does; do not
claim a complete owner graph.

Native14 proves 15 loaded NPC/mob base/emissive pairs share the same actual
ImageBitmap, with matching captured sampler/UV/upload state, but retain
30 separate native textures (about 640 MiB). An exact audit of all 17 present
manifest-referenced VRMs independently confirms duplicate embedded images
within each asset, with no cross-asset equality or declared animation/
expression/UV-mutation bindings. This identifies about 320 MiB of potential
savings, not a completed optimization or demonstrated frame-rate recovery.
Sixteen large CPU DataTexture fingerprints are distinct; they do not justify
cross-model sharing. ImageBitmap pixels were not read back or converted.

- [x] Implement conservative within-source-material base/emissive reuse only
      after verifying immutable image identity, complete texture state and
      absence of texture-mutation bindings. Fail closed for unavailable or
      dynamic metadata; keep per-instance materials and existing ownership.
      Prove exact rendered pixels, sibling lifetime and fewer native allocations
      without reducing resolution, mipmaps or quality.
- [x] Obtain valid isolated-frame diagnostic evidence, not exclusive pass cost.
      Native16 traces the previously unowned writes to the update pipeline and
      leases the complete world tick while preserving Three's animation loop.
      Five queue-drained frames have identical draw receipts, no unowned queue
      work or GPU errors, and exact hook/resource cleanup. Their median GPU
      envelope is 65.405ms; median submit-to-idle wall is 74.3ms and includes
      driver/IPC/scheduling. This freezes a partial transition, not a ready world.
- [ ] Qualify settled, matched-population rendering and normal frame cadence.
      Native16's transition still fails; its deadline starts after two initial
      animation frames, so it is not exact cut-to-ready acceptance. Native17
      restores the original cut timing and also fails. Preserve focus, LOD,
      density, resolution, terrain and shadow settings; do not sum overlapping
      timestamp intervals into exclusive pass costs or infer FPS from them.

The seven-family/12-fish scope, 14-spot capacity target, two distinct docks and
shore access remain required. Concurrent fishing, inland placement/custody,
final art and sustained performance remain open. Evidence:
`inland-pond-integration01-UNQUALIFIED/native12–14/`, including
`native14/avatar-image-audit.json`, and follow-up `native16/process.json`
and `native17/grass-budget-ledger.json`. No production rendering or asset changes
were made in this diagnostic slice.

### Native pond follow-up — fishing delivered, transition still unqualified

Native03 verifies 14 actual client fishing entities, exactly two per family.
Its per-job observations distinguish slow completion from an observed restart
loop: 57 distinct job identities for 57 keys, monotonic sampled progress, and
stable pond focus after the initial update. The unchanged 30-second settling
gate still fails; this does not approve fishing capacity, native art, gameplay,
full streaming or sustained performance.

The next diagnostic profiles the actual Chrome/Metal scene at 1280 × 720,
pixel ratio 1. Native04 records about 20.96 seconds of sampled native buffer-write
time during a 29.85-second trace; about 19.995 seconds of that occurs in shadow
binding updates. Native05 counts 524 sun-shadow renders for 524 main-scene
renders, not duplicate shadow passes. Driver/GPU backpressure can appear as
buffer-write time: these observations do not establish redundant transfers.
Grounding is real work, but its roughly one second of active slices is not the
dominant sampled cost. No grass density, terrain accuracy, shadow quality,
resolution, timeout or work-budget gate was reduced.

Native07 subsequently identifies 16 raw instance-matrix uniform bindings by
exact array identity, including eight empty resource pools. The scoped GLB
tree/resource constructor fix preserves all transforms and existing dirty
updates while selecting version-tracked storage. Twenty real-class/owner
tests, 723-root source typing and scoped lint/format checks pass. An actual
Apple Metal fixture proves exact initial/final color and shadow pixels,
32,768-byte matrix agreement, zero unchanged uploads, one dirty upload and
real GPU allocation disposal. This verifies the static helper, not wind art.

Native08 removes those raw 512-slot bindings but still fails the unchanged
30-second pond transition. Significant native buffer-write time remains,
now including grass/vegetation matrices. No sustained FPS recovery is claimed.
Grass's private per-chunk matrices are the next bounded candidate; vegetation
needs separate alternate-geometry disposal and usage review. Keep all visual
detail and gates unchanged. All owned browsers and private runtimes/databases
are closed; human localhost and 145 protected artifacts stay unchanged.

Candidate zone/custody separation, concurrent all-tier fishing, dock/shore
approaches, bank routes and final visual review remain open. These diagnostic
profiles are not uncontended performance acceptance. Evidence:
`inland-pond-integration01-UNQUALIFIED/native03–08/` and
`storage-native03/`; full details are in the development checkpoint.

### Pond layout and fishing capacity — integration gates still open

The next art candidate keeps the current inland center and both dock approaches;
it does not establish final placement, ocean clearance or gameplay acceptance.
Native18's broad arena rectangle contains ten of the fourteen fishing targets,
the supplier and arrival landing. Seven targets' entire four-metre interaction
disks lie inside that rectangle. A pond safe-zone flag cannot override the
earlier arena no-loss shortcut, ground-item restrictions or lobby challenge test.

- [ ] Finish integrated custody qualification of the explicit facility footprint.
      Shared admission, zone cache and lobby affordances are implemented.
      Actual final-position source planning and PostgreSQL drop/ammunition
      commit/replay are now qualified at the sampled candidate locations below.
      Full death/grave dispatch, opt-out evacuation and queued challenge
      transactions remain open. Preserve ordinary safe-area custody outside
      facilities; never relax economic rules to fit the pond.
- [ ] Validate the full walking width of the pond-to-bank corridor against that
      footprint and full world collision. The exact painted-width/apron check,
      sampled dry-water separation and actual individual bank trips pass below;
      crowd clearance, dynamic actors and whole-layout circulation stay open.
- [ ] Complete native/persisted all-tier fishing capacity qualification.
      Actual CPU owners now admit fourteen anglers plus seven extra arrivals
      on distinct legal shores and cover cancellation, entity re-entry and
      relocation. Extend that observed arrangement to catch/consumable durability,
      authenticated socket reconnect, full world/dock collision, supplier/bank
      journeys, rendered crowd quality and long-run repeated spawn arrangements.
      Fourteen targets alone are not capacity evidence; CPU admission alone
      does not close this integrated gate.

### Pond headland and timber checkpoint — partial native inspection, unqualified

The source study adds a southern turf headland between unequal coves and a third
ground-cover sector. Water center, datum, envelope, four-sector limit and both
dock positions remain unchanged. Measured water area is 1,034.91m² versus
1,068.73m² (96.84% retained), shoreline 117.72m, dimensions 41.97 × 34.47m.
These are shape metrics, not proof of fourteen simultaneous anglers.

The actual admitted candidate's indexed mesh passes 169,560 probes: maximum
height difference 1.099cm and facet-normal difference 3.097°, within the existing
2cm/6° checks. Mesh normal buffers are finite/unit-length and shared seams agree.
The worst leaf uses 64,670 of 65,536 permitted extra vertices, leaving only 866;
the safety ceiling is not a scalability/performance budget. Full basin PhysX,
native shading, access/custody and live fishing remain separate gates.

Compact dock timber now uses stable dock/member/board identity and a shared
local growth field for side and cut faces, with derivative-filtered grain.
One material, zero texture assets, exact physical top buffers and the legacy
zero-mask path are retained. Legacy pixel equivalence is not established.
Structural material tests are not pixel or shimmer approval.
Final CPU gates: 15 dock tests; 91 canonical terrain/path/habitat tests with one
explicit candidate-only skip; seven actual-admission checks; 729-root source
typing, scoped lint and formatting. Water/fishing has 26 passes plus one existing
historical test incompatibility: that test imposes a 12m water envelope on the
27m basin. It fails identically against the immutable old candidate. Do not
report that full run as green or relax the production containment guard.

Build11 emits eight isolated bundles from 973 source inputs, preserving 145
protected compiled artifacts. Assets-v2 is an exclusive three-manifest overlay;
the old assets/native18 inputs are unchanged. Native19 and native20 both FAIL
the unchanged 90-second startup gate, with four and thirty grass cells pending.
The latter snapshot has thirty queued/running grounding jobs, no failed/waiting
jobs, and no LOD swaps. This is not a proven causal material/shape regression;
the new shore cover can change local grounding workload. No timeout, density,
resolution, shadow or operation limit is relaxed to claim success.

Both failed browsers closed with stable input pins. Their HTTP diagnostics
attribute the 503s to /api/streaming/state: this private art runtime deliberately
disables the duel scheduler, and the endpoint confirms that state. The known
missing-model 404 remains within placeholder scope, not this art task.
No final pond/dock art, fourteen-angler gameplay, stream or smoothness approval;
all LAYOUT-01–08 gates stay open. Receipts: native19–20, isolated-build11-report,
candidate-manifest-assets-v2-report and service-layout pond-headland/dock-growth
checks. A separate post-failure art inspection cannot erase these failed gates.

Native21 is explicitly an art diagnostic, not acceptance. It passes the original
90-second startup gate; its separate 60-second inspection allowance is unused.
All three original 30-second camera/grass gates pass at 29.06s, 11.69s and 4.37s,
with fourteen fishing entities (two per family). The overall run still FAILS:
the third capture encounters a changing HUD root, and its PNG contains the
loading-timeout overlay rather than usable jetty art. The first two captures
restore their HUD leases; camera and clock restore, input pins remain stable,
and the owned browser closes. Do not report three qualified captures or a
loading/performance pass; a recorded grounding slice still reaches 42.1ms.

Root visual inspection of the usable overview and landing rejects final art:
the southern headland improves the outline, but the bank collar and service
pads still read artificial, habitat is sparse, and timber remains visibly
grid-like/crosshatched. The submitted compact dock shader is captured in
native21/shaders. It confirms the compact field is active and retained legacy
terms have zero final weight for compact geometry. The half-metre board joints
can explain broad bands, not the finer second line family. Next isolate actual
board variation, filtered growth and constant PBR under unchanged geometry,
camera and light. Fragment-hash precision amplification remains a hypothesis,
not an established cause. Do not tune from that assumption without evidence.
The third PNG is not visual evidence of the jetty. Forty-one recorded 503s
again belong to the intentionally disabled private streaming endpoint.
Runtime12, its temporary database and all owned native browsers are closed;
the human client/server/database and protected bundles remain unchanged.

### Dock shadow attribution — controlled diagnostic, defaults unchanged

Native24 isolates the actual submitted board-variation and derivative-filtered
growth nodes, then renders constant PBR on the same geometry. Board variation
is piecewise flat and growth is not the fine orthogonal grid; the grid remains
under constant PBR. Do not implement the earlier fragment-seed hypothesis.
Native26 removes the grid only when shadow reception is temporarily disabled;
actual world-space deck normals are uniform. Native27 keeps casting/reception
enabled and changes only sunlight shadow bias from +0.0002 to zero: both the
constant and production timber controls lose the fine grid. This establishes
a shadow contribution for this held landing view, not universal shadow quality.

Every successful control run passes the original 90-second startup and
30-second camera/grass gates; camera transitions take 10.971s, 12.254s and
10.839s respectively for native24, native26 and native27. Each records five
complete HUD leases, restores original material/shadow/camera/clock ownership,
closes its owned browser and retains input hashes. Baseline/restored production
fragment SHA256 is af1761d806e1077b1946cd0d07e1dab83b2b90ad47076885286ca7f334f4f0e4.
No production lighting default, shadow map size, resolution or quality changes.
Review contact shadows, low/high sun, terrain, pavilions, foliage and moving
avatars before qualifying a bias change. The single-view controls are not
sustained performance, streaming, full-scene lighting or final-art approval.

Native22/23 failed diagnostic node selection because Three wraps expressions
in unnamed intent variables; native25 failed framework discovery after the
browser resource-timing buffer discarded its entry. These helper failures are
retained, not erased or attributed to production rendering. The corrected
probe unwraps only bounded unnamed intent nodes and observes the actual loaded
framework response to preserve Three identity. No replacement shader formula.

Native21's loading-overlay failure is now attributed separately: this private
runtime intentionally disables the duel scheduler, so streaming state remains
null and the independent UI's 120-second waiting-for-duel-data deadline replaces
the loading root during the third HUD lease. Terrain was ready. This explains
that capture failure but does not erase native19/20's real 90-second grass
startup failures or demonstrate stream readiness.

References: [Three LightShadow](https://threejs.org/docs/pages/LightShadow.html)
defines normalized-depth bias and the distortion tradeoff of normal offsets;
[WGSL interpolation](https://www.w3.org/TR/WGSL/#interpolation) informed the
discarded varying hypothesis. Actual native controls, not those general
references, establish the observed attribution. Receipts: inland pond
native22–27, with original build11 and assets-v2; runtime13 and its temporary
database are stopped, protected human services unchanged.

### Fishing approach and dock support correction — scoped verification

Fishing now admits only supported, available shore tile centers within the
authoritative four-metre interaction radius. The search uses four tile rings
rather than ten (at most 81 instead of 441 candidate checks). Rejected movement
releases the shore reservation and arrival emote. After actual route exhaustion,
a pending attempt can choose a different legal shore once per tick without
resetting its deadline or completion identity. Recovery requires movement-owned
failure evidence for that exact destination, not merely an idle actor; active,
deferred and precomputed routes retain their ownership. Explicit stops,
replacement intents, synchronization and cleanup clear stale failure evidence.
No movement budget, obstruction retry count or gather deadline increased.

The new cases exercise actual terrain, occupancy, resources, tools/inventory
and movement owners. They cover occupied shores, the exact reach boundary,
rejected pathfinding, reservations/cancellation/disconnect, actual resource
relocation, four distinct arriving anglers, real obstruction retries, actual
BFS deferral and intentional stops. The three old mocked fishing cases are
superseded by these owner tests; unrelated legacy tests remain. The independent
review found and resolved an intentional-stop restart regression before freeze.
Final canonical regression06 passes 68/68; immutable baseline05 and candidate05
each pass the 18-case real-owner file with stable manifest identities. Server
source typing covers 3,954 transitive files with zero diagnostics and stable
pins; scoped lint/formatting pass. Wrong-destination failure queries and clearing
an already-present failure on stop/replacement also have actual-owner coverage.
These are CPU approach/admission checks, not transport, catches, persistence,
fourteen-concurrent-angler, overflow or economic/custody acceptance.

Compact dock support caps now meet the actual 12cm plank underside; support
shafts meet the cap underside rather than overlapping the deck's walkable top.
All 16 supports / 32 members retain their count and canonical bottom placement.
Landing remains 2,703 vertices / 1,432 triangles, jetty 3,063 / 1,576; deck
position/index prefixes remain exact. Sixteen dock cases pass, including real
Three top-surface rays, 86 retained native PhysX rays plus 16 support-site rays,
and five exact whole-buffer historical geometry goldens. No shader, material,
texture, seed, collision top or shadow setting changes. The broad type gate
passes 729 roots with zero diagnostics and stable source pins.

Build12 emits eight isolated bundles from 973 stable production inputs while
preserving all 145 protected compiled artifacts. Native28 uses those exact pins
and assets-v2 in real Chrome/Metal WebGPU. The original 90-second startup and
30-second camera/grass gates pass (10.209s from the landing camera cut). All five
HUD leases complete; material/shadow/camera/clock ownership and input hashes
restore, and the owned browser closes. Root visual inspection confirms that the
landing's overlapping support-cap patches are gone. The fine grid remains at
the original bias and disappears in the temporary zero-bias control; final
production shader hash is unchanged. This single pose does not qualify both
docks, lighting across the world or final art. Native28 records 32 expected
scheduler-disabled streaming HTTP503s and one known placeholder-mob model404,
not an error-free stream claim.

Runtime14 and its temporary database are stopped with protected human services
unchanged. All LAYOUT-01–08 gates remain open, including arena/custody separation,
fourteen-angler capacity and sustained performance. The pond bank collar,
uniform planting and simple dock silhouette still need art work.
Receipts: service-layout fishing-approach-regression06, baseline05, candidate05,
types06, dock-support-* and pond-dock-cap-types01; inland pond native28 and
isolated-build12-report. No promotion of the unqualified pond manifests.

### Facility separation and all-tier capacity — candidate source checkpoint

Explicit `duelProtection: "facility-floors-v1"` compiles immutable ring, lobby
and hospital rectangles with the same one-metre apron as the authored floors.
It is a union, not their bounding box. All existing no-loss death, grave/drop,
ground-item persistence, ammunition, opt-out and resource exclusions consume
that shared protection predicate. Ring-only combat authority is unchanged.
Zone detection uses actual components for membership, precedence and cache
edges; a pond overlap cannot replace the actual lobby with pond classification.
Client/server challenge affordances share the lobby-floor predicate, excluding
hospital, ring and apron; the queued callback rechecks both participants.

Mandatory manifest admission rejects malformed modes, missing/non-finite/
reversed/escaping envelopes and inconsistent or duplicate arena identity before
readiness, even with SKIP_VALIDATION. Unmarked historical manifests keep their
broad-zone behavior. Only detached assets-v4 opts in: world-config and stores
remain byte-identical to assets-v2, while world-areas adds the facility policy
and explicit safe arena_grounds. The grounds preserve ordinary safe-area rules
between facilities; a half-tile outward shoulder on lower edges includes the
formerly protected boundary tile centers without changing generic zone rules.
Assets-v3 is retained as the rejected exclusive-minimum-edge study. No live
manifest, protected compiled output or human service is promoted.

The new opt-in actual-owner fishing case spawns fourteen body-bound resources
(two of each family, all twelve fish), equips real players with manifest tools/
consumables and skill levels, and runs actual movement/admission. The observed
v4 arrangement admits all fourteen plus seven extra arrivals on twenty-one
distinct supported in-range shores. Real click cancellation, entity removal/
re-entry and resource relocation finish with active sessions and no pending
gathers, shore reservations or movement intents. This is not reward execution,
DB/socket reconnect, full town/dock collision, a bank journey or proof of every
randomized spawn arrangement.

Verification: final regression03 passes 152 shared cases, including actual
World/ZoneDetection cache edges and real-filesystem admission; 68 server
regressions pass with one intentional opt-in skip; candidate-v4 runs the full
19 with zero skips. Shared source typing covers 731 roots and server typing
3,953 transitive sources, both zero diagnostics/stable pins; scoped lint and
formatting pass. Existing mocked death/custody suites are regression coverage,
not real transaction acceptance. Early fixture/typing failures remain recorded;
no timeout or budget increased. Build13 emits eight isolated bundles from 973
inputs with 145 protected outputs intact.

Native29 checks the actual admitted client predicates and zone owner at eight
ring/lobby/hospital/grounds/pond points; all match, including the legacy lower
boundary and pond/lobby overlap. Its original 90-second startup gate passes;
camera/grass settling is 11.008s within the unchanged 30-second gate, and all
five HUD leases complete. Root inspected the dock captures: the grid remains
at production bias and disappears in the temporary zero-bias control. Original
materials, shadow bias, camera and clock are restored. This diagnostic is not
gameplay transaction, final-art, streaming or sustained performance acceptance.
The isolated scheduler is disabled (31 known streaming-state 503s); one known
cow-model 404 remains. No error-free-runtime claim is made.

Native29's browser is closed; runtime15 is STOPPED with no cleanup errors and
its ephemeral database removed. Protected artifacts remain unchanged. The
playable localhost session and its database are untouched.

All LAYOUT-01–08 stay open. Next: real custody/queued-challenge transactions and
full-width bank routes, then whole-scene shadow qualification and stronger
bank/planting/dock composition. The current shader bias and all quality settings
remain unchanged. Evidence: service-layout arena-footprint-* and
fishing-capacity-candidate-v4-01; inland pond assets-v4 and build13 report.

### Final source placement and PostgreSQL custody — bounded qualification

Actual GroundItemSystem planning reproduced a historical fractional-edge defect:
an unprotected request at z=348.49 snapped to the protected tile center z=348.5.
Single, batch and direct-spawn paths now recheck the final grounded position
before returning a durable plan or performing persistence, merge or presentation.
The compact integer-edged facility policy remains unchanged. Real manifest/World/Terrain/
EntityManager cases cover 36 component-edge samples, the two fail-before
planning cases and direct-spawn rejection. These four new actual-owner cases
plus 19 existing regressions pass; older mocked cases are not actual-owner proof.

Candidate PostgreSQL tests join actual grounded source planning to the real
fully migrated database, not substituted receipts. All three facility centers
reject source planning and recovered-arrow requests with no inventory/equipment
debit, operation, source or contribution. Dry pond (383.5,410.5) and grounds
(316.5,356.5) retain ordinary item-drop and ammunition custody. Fresh World/
database owners and pools replay the same operations with exact quantities,
source coordinates and one debit. All 15 PostgreSQL cases pass, including the
existing safe-death outage/recovery transaction regression. That older case is
not a new pond death-handler qualification. No projectile flight, authenticated
transport, caught-fish reward, banking transfer or crash test is claimed here.

The first candidate fixture incorrectly treated the entire water-body envelope
as submerged; actual underwater classification corrected that setup without
changing authored placement or weakening the dry-ground requirement. PG02's
14 gameplay tests passed but its cleanup observation raced Docker auto-removal.
The exact container was subsequently verified absent; PG03 and final PG04 record
clean automatic removal with a bounded observation. Each database was private/tmpfs; human
services and data were untouched.

Source-aware shared typing passes 732 roots with zero diagnostics/stable pins;
the candidate database file passes 3,165 transitive sources with zero
diagnostics, scoped lint and formatting. Build14 emits eight isolated bundles
from 973 stable inputs, preserving all 145 protected artifacts. No manifest,
served build, visual default or graphics-quality setting is promoted. This is
functional qualification, not native rendering or sustained performance
acceptance. Evidence: service-layout shore-source-before02/after02/types02,
facility-custody-pg01–04 and facility-custody-types04; inland pond build14.

### Actual pond-to-bank routes — traversable, not final layout approval

The opt-in actual-owner route lane loads four real terrain/content tiles,
generated and authored resources (48 live in the final observation), all eleven
manifest NPCs, the real bank station, arena collision walls and native CPU
PhysX dock/court/rock collision owners. Both docks have 24 support tiles. No
fake walkability, occupied-deck workaround, moved resource or substituted
movement owner is used.

The final candidate run completes sixteen round-trip cases / thirty-two legs: both
docks, one actual approach for each of seven families, and a verified dry
non-dock approach for each family. The non-dock cases reuse the seven family
start coordinates; these are sixteen executions, not sixteen distinct origins.
Every trip reaches the real
station_bank_spawn authorization boundary and returns. No sampled end-step
tile is statically blocked; root support matches the authoritative support
resolver. The full painted corridor capsule has no exact intersection with
the protected floor/apron rectangles; 34,432 perimeter samples find no pond
water. This is sampled water evidence, not continuous swept-body proof.

Observed candidate05 legs take 39–64 logical movement ticks (not wall time or FPS).
Unconstrained movement crosses traversable lobby/hospital floors on 21/32
legs; that is retained design evidence, not a forbidden-traversal regression.
The painted path is not movement authority. No invisible wall, road-only
movement rule, immunity exception or pathfinding budget change was introduced.
Earlier route03 had a different actual randomized arrangement and timings.
The final full-file run passes 20/20 using the checked-in server test config;
the opt-in route mode resolves actual PhysX and dock/court source without any
machine-local config or rebuilt dist. Source-aware server typing covers 3,954
transitive sources with zero diagnostics and stable selected pins, and scoped
lint/formatting pass.

Only one bank exists in this candidate. Add a well-composed outlying bank as
part of LAYOUT-02 and compare journey budgets rather than constraining free
movement to the painted corridor. Whole-world route/custody design remains
open, as do bank deposit/withdrawal, simultaneous traffic, dynamic mobs,
rigid-body stepping, rendered crowd quality, repeat arrangements and long-run
fishing rewards. No LAYOUT-01–08 closure or manifest promotion. Evidence:
service-layout pond-bank-routes-candidate-v4-01–05 and
pond-bank-routes-types01. Initial PhysX-loader/root and fixture occupancy/
entity-removal failures are retained; they are not gameplay acceptance.

### Secondary pond bank — candidate integration, not layout approval

The checked-in basin study now places a second open banking court at (384,438),
with chest (382,436) and clerk (386,440), on the southwest turf shoulder.
Fifteen actual-owner site probes informed selection; the chosen pre-station
10m roof envelope had 0.4132m sampled relief, supported feet and no observed
water, protected-floor, dock, resource or static-collision conflict. It is not
a new whole-court terrain pad. Detached assets-v6 replaces singular service
architecture with three explicitly bound courts while preserving the primary
bank and smithy coordinates. V5 is rejected: its clerk was absent from the NPC
catalogue. V6 includes the real bank-clerk definition and actual server spawn.

Nearest-bank discovery had a reproduced production bug: deposit-all selected
the first bank and then treated that mutable selection as an explicit filter.
Only an actual requested bank ID now filters discovery. The unchanged real
World/player/inventory/BankEntity/PostgreSQL regression fails before and passes
after the fix; all 16 PostgreSQL cases pass. The test deposits at a real second
bank fixture, reads/withdraws the same player balance in town, preserves exact
ID and range rejection, and proves replay without a second debit. This is not
a final-layout socket/crowd/restart test. Existing agent-bank regressions pass
43/43. Legacy in-memory BankingSystem/NPC event actions remain an independent
single-authority audit gap; do not infer their retirement from this result.

The outlying station's existing square blend exposed a retained-mesh mismatch:
at (385.5,439.5), canonical and indexed heights differed by 27.541mm.
Opt-in plural bank stations now reuse the bounded feature-aligned collar
partitions. No height rule, global grid, resolution, geometry cap or quality
setting changes. Focused actual-source proof reduces the witness to 0.000575mm;
6,561 envelope probes stay within 0.462349mm and all 36 footing probes within
0.098293mm. The actual affected 128-grid leaf adds 1,144 vertices, 2,288
triangles and 91,520 geometry bytes; its maximum per-cell triangle count and
all geometry caps are unchanged. This is sampled geometry, not frame approval.

Native30 admits two real banks and three rendered courts, but fails the original
30-second overview grass-transition gate. Native31 captures the outpost on
Chrome/Metal with the unchanged 1280×720 profile and an 11.78-second arrival
transition. The view is rejected for final art: tall grass crowds the interior,
there is no composed worn connector/arrival, and the outpost repeats the town
bank silhouette. No finished world, smoothness, stream or performance claim.
Native32 repeats the same outpost camera with the refined build16; its arrival
settles in 9.56 seconds, but the original 90-second startup gate fails. The
existing post-failure art-only inspection retains that failure. Native31/32
are matched placement views, not deterministic pixel comparisons (wind and
world actors remain live). Both owned browsers and private runtimes are closed.

The route expansion also exposes an unresolved real return failure:
(418.5,432.5) to town succeeds, but returning can stop at (394.5,408.5).
The final search reports 250 iterations, a partial result and an available
destination, yet exact movement is abandoned. V6-04 records fourteen
complete same-start comparisons: pond-bank round trips take 16–66 ticks versus
78–134 for town, saving 29–102 ticks per pair. Two town returns fail; their
secondary comparisons are skipped without teleporting. The one-bank v4 control
also reproduces two 250-iteration partial-return failures, so this is not unique
to the second bank. This is not 64-leg acceptance. All seven non-dock fishing
witnesses pass. Final v6-05 reproduces both failing return destinations
(418.5,432.5) and (422.5,430.5): 28 journeys are recorded, 24 complete and four
town returns fail; their four secondary comparisons are not attempted. Twelve
same-start comparisons complete. The different random resource assignment does
not erase either failure or qualify the full route matrix.

The crowded relocation failure is now attributable: a fisher at (391.5,425.5)
is boxed in by water and two occupied cardinal tiles after the fish moves to
(391.5,418.5). The only dry diagonal cannot legally pass those occupied corners;
movement rejects after one search iteration. Capacity needs safe circulation
and coordinated yielding, not extra pathfinding budget or illegal corner cuts.
At that checkpoint both failures were blocking. The bounded-navigation result
below supersedes the search failure; the independent crowd blocker remains open.

- [x] Preserve/resume bounded ground-floor detour search; distinguish unfinished
      frontier from exhaustion at unchanged budgets (CPU scope verified below).
- [ ] Preserve escape/circulation space and prove coordinated yielding plus
      relocation recovery under crowd occupancy; retain repeat arrangements.
- [ ] Compose an asymmetric worn arrival/connector, restrained planting and
      distinct outpost character; retain free off-path access and fish habitat.
- [ ] Close banking authority, authenticated transport, restart/concurrency and
      whole-layout route gates, then matched native art and sustained performance.

Final canonical verification: server regressions 68 passed / two intentional
candidate skips; shared geometry/profile/water suites 78 passed / three
candidate skips. Focused v6 retained-surface cases pass 2/2; historical singular,
paired-shoulder and seam controls pass 3/3 with exact-buffer checks. Shared
source-aware typing covers 732 roots and server typing 3,954 program sources,
both with zero diagnostics and stable source pins; scoped lint/format pass.
The attempted whole v6 overlay suite had incompatible historical fixtures;
that failed receipt remains and is not presented as a full candidate pass.

Keep LAYOUT-01–08 open. Evidence: service-layout pond-outlying-bank-sites03,
two-bank-custody-before02/after01/types02/regression01,
pond-secondary-bank-candidate-v5-01 and v6-01–05,
pond-secondary-bank-regression02/types02/format04/lint03,
bank-collar-before01/after01/stock-regression02/v6-actual-final01/
singular52-final01/types-final01/eslint-final01;
inland pond assets-v5/v6, build15/16, runtime16–19 and native30–32.
Failed receipts are retained; the human localhost and its database are untouched.

### Bounded pond navigation — CPU recovery, not whole-layout acceptance

The two stranded pond returns are now deterministic regression cases, not
randomized success claims. Before the fix both rejected valid destinations
after 250 search iterations. Ground-floor non-combat movement now retains a
stationary-start guided frontier when its slice yields without a useful path.
Pending, found and exhausted are separate outcomes. Every heap pop, including
stale entries, is charged; the 250-per-search-slice and 1,000-per-tick limits, search
radius, legal diagonal corners and route deadlines are unchanged. Ordinary
useful segments are still published immediately; this is not a replacement
navigation framework or a larger search allowance.

Each paused actor owns copied goals, heap, parents and costs. Repeated intent
does not restart it; changed start/goal/arrival set/floor, relevant collision,
cancellation, synchronization, cleanup and world teardown retire stale work.
Collision owners publish effective changes from base flags, regions, leases
and network updates. Unrelated distant changes do not restart a job. Static
terrain caches survive occupancy-only changes, while affected directional
entries are invalidated because they include occupants and diagonal supports.
Same-tick cache failures were reproduced before this correction. At most 72
nearby edge keys are invalidated per changed tile; there is no full graph scan.

Retained work is limited to ground-floor owners with the change-notification
contract. Upper-floor topology keeps its historical one-shot behavior. This
does not claim arbitrary live terrain/profile editing, all building floors or
third-party mutation of exported collision arrays. Authoritative movement
still checks each actual step; no actor teleport or collision relaxation was
introduced. A route longer than the existing 200-tile returned segment now
keeps continuation metadata instead of prematurely appearing complete.

[Detour's sliced search](https://github.com/recastnavigation/recastnavigation/blob/main/Detour/Source/DetourNavMeshQuery.cpp#L1208-L1414)
and [shared-budget queue](https://github.com/recastnavigation/recastnavigation/blob/main/DetourCrowd/Source/DetourPathQueue.cpp#L72-L125)
informed explicit in-progress state, retained frontier ownership and consumed
work accounting. [Amit Patel's moving-obstacle guidance](https://theory.stanford.edu/~amitp/GameProgramming/MovingObstacles.html)
informed local invalidation rather than discarding every route for unrelated
world movement. These are technique references, not copied code or a new dependency.

This checkpoint supersedes only the earlier incomplete-route result, not the
crowd or visual rejection. Final actual-owner candidate02 passes 34 tests with
the known capacity case skipped; canonical regressions pass 68 with 17 opt-in
skips. The two deterministic stranded starts now arrive in 13 and 16 logical
ticks. The complete fixture records 32/32 round trips (64 legs), sixteen paired
comparisons from ten distinct physical starts. Town-bank trips total 1,623
logical ticks versus 591 for the pond bank in this arrangement. These are
sequential routes, not simultaneous throughput or wall-clock performance.

All seven non-dock fishing-family witnesses pass actual gathering admission.
Fourteen body-bound resources cover all twelve fish IDs, but this does not
prove every reward caught, fourteen concurrent anglers plus overflow, fishing
from both docks, physical simulation stepping, transport or restart behavior.
The two distinct dock meshes have valid deck–bank–deck routes; final art and
the full LAYOUT-07 acceptance remain open.

Shared movement regressions pass 397/397. Shared test-inclusive typing covers
707 roots / 2,382 sources, and server test-inclusive typing 3,954 sources, with
zero diagnostics and stable pins. Same-tick static/occupancy cache changes,
repeated intents, relevant/distant mutations, cancellation, synchronization,
missing-entity look-ahead and manager destruction have actual-owner coverage.
The five-player saturation case proves shared-budget deferral, not crowd
arrival performance. Scoped lint, format and independent review pass. Earlier
before-fix failures and test-fixture/type-harness corrections remain recorded.

Build18 emits eight isolated bundles from 973 stable production inputs;
build17 is superseded. Native33 uses build18/assets-v6 in actual Chrome/Metal
WebGPU at unchanged 1280×720. The original 90-second startup gate passes in
this run; outpost grass settling takes 10.88 seconds within the original
30-second capture gate. Earlier startup/transition failures are not erased,
and this diagnostic camera view is not native route gameplay, streaming,
seamless transitions or sustained performance acceptance. The court still has
excessive grass, no composed worn connector and a repeated bank silhouette;
final art remains rejected. Streaming-state polling returns 503 in this
isolated mode and the known unmodeled mob asset returns 404; neither is hidden
as a clean runtime. Owned browser33/runtime20 are closed and its ephemeral
database removed; human localhost/database and all 145 protected compiled
artifacts remain unchanged.

Evidence: service-layout pond-stranded-route-before01, pond-route-cache-before01,
pond-route-cache-candidate02/regression02/types02/lint02/format04,
guided-resume-tests02/shared-regression01/shared-types01;
inland pond build17/18, isolated-build18-report.json, runtime20 and native33.
No live/default candidate promotion, shader/density reduction or extra budget.

- [x] Recover the two deterministic stationary-start pond detours with retained
      bounded ground-floor search, precise invalidation and lifecycle tests.
- [x] Complete the sequential 32-roundtrip candidate CPU route matrix.
- [ ] Prove fourteen concurrent anglers plus overflow, every-tier dock/shore
      gathering, all twelve rewards, crowded relocation, departure and re-entry.
- [ ] Qualify native movement/gathering, authenticated banking/restart, repeated
      startup, outpost/shore/dock art and whole-island sustained performance.

The recorded crowded relocation failure is separate. The following checkpoint
adds last-exit admission prevention, but broader circulation/recovery remains
open. Any cooperative yield must
be owned by eligible autonomous agents, honor duel/private-preparation/operator
fences, and stop gathering through its real completion authority. Do not force
human movement, introduce invisible corridors, cut occupied diagonal corners
or increase the deadline. Preserve the fourteen-angler/all-tier/overflow
requirement when proving the solution.

### Fishing stance circulation — trap prevention, capacity sampled

A deterministic reproduction now records three real equipped anglers arriving
at (391,425), (391,426) and (390,425). The third stationary admission removes
the first fisher's last legal exit; the remaining dry diagonal correctly fails
corner clearance. After actual gathering cancellation, the old departure fails
after one search iteration. This is an authored reproduction on actual basin
terrain/resources/occupancy, not a synthetic relocation or randomized success.

Fishing stance selection now protects nearby actual player occupants and
pending approach reservations. Each candidate and protected neighboring stance
must retain a canonical legal adjacent step, including both diagonal supports.
The overlay is read-only: it does not place collision walls, restrict normal
walking, move other players, change terrain or run another path search.
Real occupancy continues protection after gathering stops until the actor
actually leaves. No duplicate active-gatherer event mirror is introduced.

Arrival rechecks the stance and may try another shore under the original
attempt/deadline. The actual ResourceSystem validates new fishing admission
against the server-owned player position, covering direct/legacy gather calls.
An exclusive, identity-safe validator lease fails closed during owner retirement
until a replacement binds. Network teardown retires pending gathering before
movement; repeated disposal cannot remove a newer owner. Non-fishing unbound
event dispatch and existing active-session behavior are unchanged.

Six deterministic actual-owner cases pass: three-actor admission, pending
reservations, stopped-but-present occupants, arrival race, direct resource
rejection and owner retirement/rebind. Final candidate02 passes 40 cases with
one capacity skip; canonical regression02 passes 68 with 23 opt-in skips.
The full sequential route matrix remains 32/32 roundtrips (64 legs), sixteen
paired comparisons from ten distinct starts. In this arrangement the town
bank totals 1,691 logical ticks and the pond bank 508.

One separately selected, unchanged full capacity case (v6-01) passes fourteen
anglers plus seven accepted extras on twenty-one distinct supported positions,
actual owner re-entry and actual fish relocation, ending with zero pending
gathers or reservations. This is one random arrangement, not repeated
reliability, all twelve rewards, real socket/agent-behavior concurrency, native
physics stepping, full-route connectivity or sustained performance proof.
The capacity fixture does not include the dock/court/rock physics owners used
by the separate route fixture, and does not log exact phase tick counts; each
phase passed its unchanged twenty-tick bound. The deterministic trap is prevented;
arbitrary walking/stopping can still
block circulation, and immediate free steps do not exclude larger closed pockets.

The old four-metre boundary fixture used trapped player blockers to isolate
range. Its two failed suite receipts remain. It now uses scoped real static
collision leases and explicitly proves the outward exit; exact range, support
and actual gathering assertions are retained. The capacity test body is
byte-identical to the preceding checkpoint.

Shared resource-owner/fishing-ecology/lifecycle regressions pass 34/34. Full
shared source typing covers 707 roots / 2,382 sources; server test-inclusive
typing covers 3,954 sources with ten roots, including ResourceSystem. Both
report zero diagnostics and stable pins. Scoped lint/format and independent
review pass. Work is local and bounded, but the additional admission-query
cost remains unqualified under sustained many-agent load.

Build19 emits eight isolated bundles from 973 stable production inputs.
Native34 boots actual Chrome/Metal WebGPU at unchanged 1280×720 and passes
the original ninety-second startup gate; outpost capture settling is 9.84s
within the unchanged thirty-second gate. Camera/input state is restored and
the owned browser/runtime21 are closed with the ephemeral database removed.
Human localhost/database, all 145 compiled artifacts and build/lock inputs
remain untouched. This diagnostic view is not native crowd gameplay or
sustained performance. Art is still rejected for excessive court grass,
missing worn arrival and repeated pavilion character. The isolated stream
endpoint's 503s and known unmodeled-mob 404 remain recorded.

- [x] Prevent the recorded last-exit closure through real pending/final
      admission, retaining protection through actual departure.
- [x] Pass one unchanged fourteen-plus-seven CPU capacity/re-entry/relocation
      arrangement without expanding movement or pending-gather budgets.
- [ ] Prove repeated arrangements, larger-pocket connectivity, autonomous
      yielding/recovery and many-agent native movement/gathering/reward timing.
- [ ] Qualify outpost/shore/dock art, startup reliability, authenticated bank
      authority/restart and whole-island sustained performance.

Keep LAYOUT-01–08 open. Evidence: service-layout pond-egress-admission-before01/
after01/candidate01–02/regression01–02/types02/lint02/format03,
pond-egress-capacity-v6-01, pond-egress-resource-regression01/shared-types01/
root-eslint01 and fishing-stance-pending-eslint02; inland pond build19,
runtime21 and native34. Failed receipts remain; no live/default promotion.

### Pond outpost composition — source checkpoint, visual qualification open

The pond scope remains seven fishing families, twelve fish, fourteen simultaneous
anglers plus safe additional arrivals, a dry shore option for every tier, and two
distinct procedural docks. Current candidate assets-v7 retains the assets-v6
basin, all fourteen fish placements, supplier, water level, terrain grades and
two dock placements; only the outlying bank's explicit pavilion recipe changes.

The outpost now has a bound landward connector, chest-to-clerk service wear and
one unequal partial activity patch. These reuse the existing terrain/grass road
field and add no floor, obstacle, navigation restriction, shader or material.
Historical primary-bank path descriptors remain exact. The actual emitted grass
worker and terrain field agree at 270 added-path/shoulder probes. The baseline pond test
adds 51 segments (501 total, below the existing 600 bound) with a 256 mask.
The independent filtered lattice found existing dock-apron bleed up to 0.178612;
new wear does not increase it at sampled dock/wet locations. This is not a claim
of a globally zero halo or verified grass-root density. The native meadow
candidate has its own actual mask/domain and still needs separate qualification.

The opt-in lake-facing pavilion uses a lower 22-degree open roof, asymmetric
exposed beam ends and one north-facing key plaque. Actual geometry is 1,396
triangles / 231,888 attribute bytes in three private material batches, versus
unchanged town geometry at 1,492 / 247,200. Fixed post/foot positions, four open
passages, roof cutaway ownership and collision-owner selection remain aligned.
Strict readiness accepts only the exact matching recipe/count contract; a
legacy singular descriptor cannot silently select the pond recipe.

Native35 build20/assets-v7 passed the unchanged ninety-second startup gate and
loaded all fourteen fish in real Chrome/Metal WebGPU at 1280x720. Its first
pond-overview cut FAILED: cell gcell_v1_16_17 (x400..425, z425..450, LOD0)
exceeded the unchanged 250ms active CPU grounding limit at 251.9ms / 646,144
operations. Its failure image is diagnostic only, not art/performance approval.
The scene still needs a less continuous shore collar, stronger asymmetric bank
composition and complete dock/outpost art. Do not lower density/resolution or
raise work/settling budgets to turn this into a pass.

Reference use: the official [Three.js procedural terrain example source](https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/webgpu_tsl_procedural_terrain.html)
separates terrain-height/normal evaluation from slope/height material treatment.
It is a technique reference, not evidence that this island meets an AAA or
performance bar; existing shared authoritative terrain/grass ownership remains.

Native36 is a separate close art diagnostic, not a retry that erases native35.
It MISSED the same ninety-second startup gate; post-failure inspection then
settled the outpost camera in 12.113s under the unchanged thirty-second camera
gate. Matched native34/native36 images show the lower roof and exposed service
wear, but grass still overwhelms the setting and the pavilion lacks sufficient
landscape character. No AAA art approval or startup/performance approval.

Final focused path/field/owner/PhysX/visual suite: 69/69. Procgen geometry suite:
15/15. Existing client scene-diagnostics suite: 21/21. Full shared production
plus explicit changed tests/readiness typing: 709 roots / 2,384 sources, zero
diagnostics and stable pins. Scoped lint/format and independent source review
pass. Build20 emits eight isolated bundles from 973 stable source inputs.
Early fixture/type/alias failures are retained; final tests use the exact shared
source identity instead of the deliberately protected older compiled runtime.

Both owned browsers and runtime22 are closed; its temporary database is removed.
All 145 protected compiled artifacts, six build inputs, retained package lock and
human localhost remain unchanged; eight common status mirrors match. LAYOUT-01–08
remain open and no candidate default is promoted. Next: profile the exact failed
southern-bank cell, make a quality-preserving grounding improvement, repeat
startup/camera transitions, then continue natural pond/dock/outpost composition
and integrated fishing gameplay. Do not substitute a static still for those gates.

Evidence: service-layout pond-outpost-wear01–05 (final05), pond-bank-recipe-tests01,
pond-bank-recipe-owner01 (old compiled alias failure), pond-outpost-types01–03
(final03), pond-outpost-client-regression01 and pond-outpost-lint01; inland pond
build20, runtime22 and native35–36. Detached assets-v7 differs from assets-v6 in
the single outpost recipe selection only; both are unqualified.

### Pond south-bank grounding — exact output verified, transition performance open

The assets-v7 southern pond cell now has a reproducible real-owner regression:
gcell_v1_16_17, LOD0, x400..425/z425..450, focus 435/452. It uses the actual
emitted worker and the retained 450/450 and 350/450 terrain leaves. The original
review52 fixture remains separately selectable; neither overlay is a default.

The height/face-only terrain sampler shares the original Float32 cell selection,
indexed face order, edge determinants and height arithmetic. Only grass blade
endpoint queries opt into it; anchor validation still computes full normals.
This removes 46,560 unused endpoint normal evaluations in the selected cell
without changing geometry, clump count, density, wind, materials or budgets.
The output hash remains af12d68c1875e5b95cf880f26df31fe48ca76452cfe4cb11c904cfaff00ed91d.

Before/after both project 970 clumps and retain 931, with 39 water rejections,
347,209 triangle visits, 1,931 same-face edges, 912,895/1,000,000 geometric work
units and 709,023 continuation resumptions. Independent frozen legacy per-clump
checks agree on data, corrections, visibility, bounds and dependency ordering.
Single-run CPU continuation readings 179.688ms before, 177.620ms and 185.319ms
after show no established overall speed improvement. They do not overturn the
native35 failure or qualify browser performance.

Final targeted terrain/south-bank suite: 59 passed/one other-overlay skip; broad
grass regression: 419/419; original review52 fixture passes separately. Tests
include real raycast/indexed geometry, skinny faces, pinned shared-edge IDs,
recorded Float32 outer-edge failures and untouched output on invalid queries.
Full shared production and explicit changed tests: 707 roots / 2,382 source files,
zero diagnostics and stable pins. Scoped lint/format pass. A readonly tuple
inference error in the first test-inclusive typecheck was fixed explicitly;
that failed receipt remains. Build21 emits eight bundles from 973 stable inputs.

Native37 uses build21/assets-v7 in real Chrome/Metal at 1280x720. It passes the
unchanged ninety-second startup gate and loads all fourteen fishing entities.
The original southern-cell active CPU failure does not recur in this run, but
the thirty-second pond-overview camera gate still FAILS. At the deadline,
three LOD1 updates remain running, two with zero operations; no jobs are failed,
cancelled or waiting on support. Its 29.714s observation interval advances the
renderer frame counter by 618 and adds 1,157.4ms of grounding slice time.
This is loading-time observation, not calibrated FPS, GPU attribution or proof
that the sampler caused the difference. The last target-cell sample is
691,904 operations / 218.0ms; no completed per-cell native receipt was captured.
The failure still remains diagnostic only. Art review still rejects the
continuous shore ring, sparse bank detail and overall landscape composition.

Native38 is a separate CPU-only sampled diagnostic. Startup passes and the same
camera settles in 29.352s with all queues zero, only 0.648s inside the original
limit. It does not erase native37 or prove stable readiness. The profile is
30.3497s long, with 23,639 valid samples and 30.349406s of sampled deltas;
the first 0.945274s belongs to program/setup, not an application function.
Exact grounding ancestry is 1.048078s (3.45%). Native writeBuffer accounts for
15.969750s (52.62%), including 15.226129s in shadow uniform-buffer updates;
getCurrentTexture adds 3.664026s. These are main-thread/native-call residency,
not GPU execution time or proven upload volume. Synchronization/backpressure
remains a possible cause. Do not assume a recurrence of the old matrix issue.

Next priority: identify actual shadow uniform-buffer owners, write sizes/ranges
and frequency, and correlate with per-pass GPU timestamps before changing
rendering. Preserve shadows and all quality/readiness limits. The diagnostic
approach follows the [Chrome runtime performance reference](https://developer.chrome.com/docs/devtools/performance/reference).
The full attribution and caveats are in native38/CPU_PROFILE_REVIEW.md.
Both test browsers and runtime23 are closed; its temporary database is removed.
All 145 protected compiled artifacts, six build inputs, retained lock and human
localhost remain unchanged. No avatar, pond placement, fish, dock, terrain,
material, wind or shadow settings changed in this source checkpoint.

- [x] Reproduce the southern-bank cell with actual worker/retained terrain and
      independent exact-output comparisons.
- [x] Remove unused endpoint-normal evaluation and retain full anchor normals.
- [x] Capture pre-cut CPU attribution without draw/upload/GPU wrappers.
- [ ] Qualify repeated startup/camera transitions with useful margin, then
      seamless gameplay/streaming camera behavior and sustained performance.
- [ ] Correlate shadow buffer traffic with GPU pass cost before selecting a fix.

The seven fishing families/twelve fish, fourteen simultaneous anglers plus safe
overflow, dry shore access for every tier and two distinct docks remain open
integrated acceptance requirements. Natural shore composition, dock/outpost art,
real native fishing/banking/restart and sustained world cost are not closed.
All LAYOUT-01–08 remain open; no candidate default promotion or budget increase.

Evidence: service-layout pond-south-grounding-before01,
pond-south-height-sampler01–02, pond-height-regression01,
pond-height-review52-regression01–02, pond-height-types01–02 (final02),
pond-height-lint01–02 and pond-height-format01; inland pond build21/runtime23/native37–38 and native38/CPU_PROFILE_REVIEW.md.

### Vegetation matrix storage — upload waste removed, readiness still failing

Native39–40 identify the shadow upload source before changing game code.
The observer measures actual queue.writeBuffer arguments, not logical buffer
capacity, and matches samples to native timestamp pairs by sample/frame/context/
pass. CPU call residence is not GPU execution time. Native39's metadata limit
truncated 13 groups of 84 uniforms at 32 (676 omitted entries); that incomplete
receipt and its 30.003s transition failure remain recorded. The bounded metadata
limit is now 128, not a change to game budgets or graphics quality.

Native40 has a complete observer receipt: all 156 sampled mushroom matrix writes
match both actual instanceMatrix.array and BufferNode.value. The six chunks
upload their entire 256-slot/16,384-byte allocation in main and shadow passes.
Their dirty versions also advance during loading, so not every write is proven
redundant. Independently, the south-bank gcell_v1_16_17 fails its unchanged
250ms cumulative active CPU gate at 250.400ms / 673,792 operations.

The primary vegetation chunk constructor now reuses createStorageInstancedMesh.
Its existing population/finalizeChunk dirty flush remains authoritative. Both
hero and borrowed screen-space LOD geometries register the same storage matrix
for lifetime cleanup, including first use at LOD1. Counts, matrix bytes, transforms,
bounds, materials, wind, camera/LOD criteria and shadow flags are unchanged.
Legacy separate LOD1/LOD2 constructors are deliberately outside this checkpoint.
This follows the installed Three instance/storage/attribute ownership paths and
its documented [dirty-version contract](https://threejs.org/docs/pages/BufferAttribute.html)
and [WebGPU storage attributes](https://threejs.org/docs/pages/StorageInstancedBufferAttribute.html);
generic uniform regrouping was not applied.

Final CPU regression: 287/287 across seven suites, including actual registered
World owners, real HTTP late LOD publication, matrix-byte/version comparisons,
ray/bounds parity, grass ownership and tree lifetime. Full shared production plus
explicit affected tests: 707 roots / 2,382 sources / zero diagnostics, stable pins.
Scoped lint/format pass. The initial explicit test-inclusive typecheck exposed
seven material/listener union errors; actual instanceof narrowing and concrete
event-owner registration fix them without casts/mocks. The failed receipt remains.
CPU disposal-event tests do not prove native GPU resource reclamation.

Build22 emits eight isolated bundles from 973 stable inputs. Native41 uses
real Chrome/Metal, 1280x720, unchanged rendering and readiness budgets. Its
30 sampled buffer frames correlate to 151 native pass rows with no unassigned
pass, errors or overflow (one additional timing-only cleanup-tail frame excluded).
No mushroom matrix writes occur through either observed binding or attribute
routes in those sampled frames. This is not a claim of no updates between samples.
All 18 primary chunks retain 256-slot static storage and both geometry registrations;
eight existing GPU allocations are observed, six chunks visible at the final view.

Native41 still FAILS the thirty-second camera gate at 30.001s with five LOD jobs
running, none failed. The dominant synchronous write residence moves to an ocean
uniform: 90 calls totaling only 720 bytes, but 733.800ms. Matched-frame median CPU
render time is 46.0ms; the native timestamp envelope median is 92.209ms. Native
pass intervals can overlap and are not summed as exclusive GPU costs. This is
consistent with synchronization/backpressure relocating, not a solved bottleneck
or evidence that tiny water uniforms should be removed.

Native42 is a separate uninstrumented build22 run. Startup passes; the first
camera fails at 18.323s because the same southern-bank job exceeds its active CPU
gate: 250.400ms / 708,224 operations. Later views do not run. No deadline, density,
resolution, shadow or per-job budget was weakened. Both target performance gates
remain open. All fourteen real fishing entities reach the client.

The actual native41 failure-scene still was inspected after the HUD was reversibly
hidden. It still shows an overly oval pond, continuous brown shore collar, sparse
bank composition and insufficient dock/pavilion character. No new art approval.
All four owned browsers, runtime24/25 and their temporary databases are closed;
protected human localhost/database and compiled/build inputs remain unchanged.

- [x] Attribute actual shadow matrix writes and correlate bounded native samples.
- [x] Use versioned primary vegetation storage with exact CPU ownership regressions.
- [x] Observe the targeted upload removal in the real renderer without lowering quality.
- [ ] Remove the residual render/backpressure bottleneck; do not mistake a blocking
      write call for its underlying cause.
- [ ] Bring the exact south-bank grounding job below its existing active CPU budget
      with margin, preserving output; repeat native startup/camera gates.
- [ ] Verify actual GPU retirement/reload and sustained gameplay, not only CPU events.
- [ ] Finish natural shore/dock/outpost art and all-tier native fishing/banking tests.

Seven fishing families/twelve fish, fourteen simultaneous anglers plus safe
overflow, shore access at every tier and two distinct docks remain required.
All LAYOUT-01–08 remain open. No default promotion, merge, deployment or AAA claim.

Evidence: service-layout pond-vegetation-storage01–02 (final02), types01–02
(final02), lint01/format01; inland pond build21/runtime24/native39–40,
build22/runtime25/native41–42 and native41/SHADOW_BUFFER_REVIEW.md.

### Indexed grass edge batching — faster exact work, full acceptance still open

The indexed edge path now shares one generator suspension across four bounded
cursor steps. Each step still checks its retained geometry and charges its
individual geometric work; triangle order, clipping, roots and fallback behavior
are unchanged. There is no new index/cache allocation or reduction in density,
detail, resolution or shadows. The 1M geometric-work/resumption, 8192 slice-operation,
2ms cooperative slice and 250ms cumulative-active limits remain unchanged.
Clock checks are coarser: 64 resumptions can now span 256 indexed steps. This is
not a hard 2ms preemption guarantee.

The exact southern real-worker fixture retains 931/970 clumps, rejects 39 at
water and preserves 347,209 triangle visits, 46,560 endpoint queries and 912,895
work units. Resumptions fall from 709,023 to 361,585; full-cell CPU active time
is 184.827ms before and 157.587/156.713ms in two candidate runs. Output hash stays
af12d68c1875e5b95cf880f26df31fe48ca76452cfe4cb11c904cfaff00ed91d.
Maximum CPU slices are 2.234/2.913ms versus baseline 2.421ms. These short samples
are not a whole-game frame-time or GPU improvement claim. A four-face index trial
was rejected for 81% more index bytes; shared clump ranges were rejected for
higher work and slower execution. Neither rejected change remains in source.

Verification: 405/405 across eleven grass/terrain suites, plus 103/103 same-face
cases including 31 new dense-index/fallback/suspension/budget/invalidation cases.
Both actual south-bank and original review52 assets pass the frozen exhaustive
oracle, now including all semantic receipt fields. Full shared production plus
all three changed files: 707 roots / 2,382 source files / zero diagnostics and
stable pins. Scoped lint/format and independent read-only review pass.

Build23 emits eight isolated bundles from 973 stable inputs. Native43 and44 use
real Chrome/Metal WebGPU, unchanged 1280x720/DPR1/4-sample diagnostic rendering,
no transition profiler and the original startup/camera gates. Both pass startup
and the first three grass-settling gates with empty final queues and no observed
grounding failures. Overview/landing/jetty elapsed times are 26.760/10.438/4.515s
and 24.503/10.120/3.924s respectively. These multi-second transitions are NOT
seamless gameplay acceptance. The southern job is observed running below its
limit and then leaves the queue; 1Hz sampling does not capture its exact terminal
active time. Global maximum slices of 18.7/11.4ms already exist before the cuts
and do not increase during them; smooth pacing remains unqualified.

Both native runs still have FAILED terminal status. Native43 detects the stream
boot-timeout overlay before the third image. Native44's third image is saved,
but its HUD-restoration identity check fails as the boot timeout changes the
loading root. The fourth view does not run in either. Their no-money world
fixture deliberately disables streaming duels and reports waiting_for_duel_data;
the real stream screen requires that data and retains its 120s timeout.
This is an incompatible capture/stream-readiness fixture boundary, not evidence
of an established production stream regression. No timeout, health gate or
production UI was weakened, and no fake stream state was injected.

- [x] Reduce exact indexed grounding suspension overhead with output parity.
- [x] Repeat the first three native grass-settling gates without the former failure.
- [ ] Separate world-art capture from real stream admission, or provide real
      no-money duel data; complete all four views with clean HUD restoration.
- [ ] Qualify sustained frame pacing, shadow/backpressure cost and actual GPU
      retirement/reload without lowering visual quality or raising budgets.
- [ ] Improve natural shore shape/material transitions, bank habitats and both
      dock designs; verify actual all-tier fishing, navigation and banking.

The pond must retain room for seven fishing families/twelve fish, fourteen
simultaneous anglers plus safe overflow, dry shore access at every tier and two
distinct procedural docks. All fourteen fishing entities reach both native
clients, but concurrent live fishing throughput is not yet proven. The inspected
images still show an overly uniform shore collar, sparse banks and plain docks;
this checkpoint does not approve the art. All LAYOUT-01–08 remain open.

Both browsers and runtime26's disposable database are closed; protected human
localhost/database and compiled/build inputs are unchanged. No default promotion,
merge, deployment or AAA/performance/streaming approval.

Evidence: service-layout pond-south-edge-before01, pond-south-batch01–02,
pond-edge-batch-review52-01, pond-edge-batch-regression01,
pond-edge-batch-sameface01, pond-edge-batch-types02,
pond-edge-batch-lint02/format02; inland pond build23/runtime26/native43–44.

### Pond world-art capture and bounded dock chamfers — 2026-09-21

The private art fixture now mounts the real GameClient without StreamingMode.
It retains real server admission, production render preferences, WebGPU and the
original startup/grass-transition gates; it does not fabricate duel state or
disable the real stream screen's timeout. No-money flags remain unchanged.

Native46 (build23 baseline) and native47 (build24 candidate) capture all four
matched views at 1280x720/DPR1/four samples with the same existing shadow profile.
Native47 additionally asserts the exact served framework path and stable source
pins, records bounded console/HTTP/transport evidence without overflow, and
rechecks it through unmount before owned browser closure. Both statuses are
WORLD_ART_CAPTURED_NO_STREAM_OR_PERFORMANCE_ACCEPTANCE, not launch acceptance.
Native45's strict missing-cow failure is preserved. The user-deferred cow 404 and
five corresponding errors remain explicit; its current invisible hitbox is NOT
a visible placeholder. No other native47 resource/console/transport error occurs.

Compact dock rail assemblies now use 44-triangle flat-face chamfered members.
Walking tops, aprons, supporting timbers, original outer member bounds and
legacy docks stay unchanged. Collision triangles change with the visible rails:
actual native-PhysX tests verify barriers and intended openings, not byte parity.
The two merged meshes retain one shared material; totals rise from 3,008 to
4,928 triangles and 340,944 to 574,224 CPU geometry bytes. This is not a GPU
allocation, frame-time or scalability approval. Matched eye-level review finds
cleaner cap/post edges, but the improvement is modest; plain repetitive timber,
the uniform brown shore collar and sparse bank composition remain art gaps.

Stock and candidate dock/layout tests pass 23/23; final candidate repeat passes
23/23. Full shared production plus both changed files: 706 roots, 2,381 source
files, zero diagnostics and stable pins. Scoped lint/format pass. Earlier test
typing/format failures are retained and corrected with concrete attribute checks.
Build24 emits eight isolated bundles from 973 stable inputs.

Native47's four grass gates finish in 23.407/9.998/3.991/9.286 seconds with empty
final queues and no observed failed jobs. Its 5.3ms global maximum slice is not
whole-frame pacing evidence. These are held-camera captures, not seamless travel.
All fourteen fishing entities remain present: two per family. Browser art
captures do not exercise player collision, bank transactions or concurrent fishing.

- [x] Separate real world-art inspection from incompatible stream admission.
- [x] Capture matched four-view baseline/candidate and test bounded timber edges.
- [ ] Naturalize the basin outline and shore transitions; compose richer banks
      and more characterful docks without obstructing fishing or circulation.
- [ ] Prove seven families/twelve fish, fourteen simultaneous anglers plus safe
      overflow, dry shore access at every tier, both docks and the bank route.
- [ ] Complete live navigation, concurrent fishing/rewards, sustained native
      performance, GPU retirement and real stream verification.

Both owned browsers and runtimes27/28 are closed, their temporary databases
removed, and protected human localhost/bundles unchanged. All LAYOUT-01–08 remain
open. No default promotion, merge, deployment or AAA claim.

Evidence: service-layout dock-chamfer-stock01/v7-03/types04/lint02/format03;
inland pond build24, runtimes27–28 and natives45–47.

### Asymmetric pond headland and retained fishing capacity — 2026-09-21

The isolated assets-v8 study deepens one southern turf headland, separating the
eastern shelf from the southwest bay. Its waterline recedes 3.063m locally;
water datum, other bank sectors, dock landings, western bank approach, roads and
material composition stay fixed. The additive southernHeadlandStudy recipe is
tracked alongside, not over, the historical fixture. Byte-exact reproduction
of the retained v8 manifest passes. This is not a canonical/default promotion.

The first actual v8 terrain build correctly failed its 65,536-extra-vertex cap.
A bounded topology correction now fans rectangular broad-adaptive patches with
exactly one subdivided edge from an opposite original corner, retaining every
boundary vertex and the original diagonal without an extra interior vertex.
Multi-edge junctions and historical non-broad patches keep their center fan.
No cap, error tolerance, finest lattice, grass density or quality setting rises.
This changes interpolated geometry; byte-identical prior grounding is NOT claimed.

Actual v7/v8 terrain-versus-worker checks cover 169,560 probes per version:
maximum height error 10.988mm and normal error 3.987 degrees stay inside the
existing 20mm/6-degree gates. 137,061 outside-sector authority samples and 19,023
protected dock/west-bank height/normal samples agree between v7 and v8; 360 spokes
per version retain one continuous wet interval. Seams pass. Maximum additional
vertices are 63,519 and maximum faces/cell 366 under unchanged caps.

Candidate dock/native-PhysX/layout tests pass 23/23. Actual v8 resource coverage
verifies fourteen unique fishing entities (two per family, exact seven-family/
twelve-fish catalog mappings), dry walkable approaches, pending-registration deduplication
and three relocation waves. It does NOT catch every fish or prove live anglers.
These are local supported dry-approach witnesses, not pairwise-disjoint occupied
stances or connected routes with all dock/court/rock collision owners installed.
Stock terrain/dock regression passes 85 cases; real stock fishing passes nine.
The final dense surface repeat and combined selected authority/fishing repeat
pass. Counts overlap and are not a unique aggregate. Earlier failures remain.
The exact named catalog is checked against both loaded yields and actual resource
drops before/after relocation. Its first broader invocation also ran a historical
default-campus case under v8 and failed that incompatible fixture assertion;
selected v8 and stock cases must run separately. No old assertion is weakened.

Actual full-cell grass checks pass against frozen exhaustive per-clump oracles:
v8 retains 966/1,009 clumps, 935,622 work units, 155.006ms cumulative CPU active;
v7 retains 930/970, 887,617 units, 150.802ms. Both stay inside the unchanged 1M-work
and 250ms-active gates. v7's prior geometry retained 931 clumps; the new topology
rejects one additional water clump. This is bounded correctness, not output parity
with the prior mesh or native FPS acceptance. Full shared plus six changed test/
source files typecheck: 710 roots, 2,385 files, zero diagnostics, stable pins.
Scoped lint, formatting and tracked study reconstruction pass.

Build25 emits eight isolated bundles from 973 stable inputs. Native48 captures
all four real headful Metal/WebGPU views, verifies the exact served framework and
stable source/manifest pins, and reports no unexpected console/transport failure.
The four held-camera grass gates finish in 22.621/9.384/3.609/9.836 seconds, with
empty final queues and no observed failed jobs; maximum observed slices 3.5/3.5/
5.0/5.0ms are not full-frame pacing. The Mac was on battery, so this is not a
controlled performance comparison. All fourteen fishing entities remain visible
to the client in each view. Known cow errors remain explicitly deferred; its
invisible hitbox is still not a visible placeholder or full-asset acceptance.

Four-view visual review confirms the two unequal bays and intact dock landings.
The uniform brown collar, sparse shoreline planting, plain timber and bank
pavilion circulation still need substantial art/gameplay work. Reference review
favored deliberately authored habitat regions over indiscriminate noise, using
[Guerrilla's placement breakdown](https://www.guerrilla-games.com/read/gpu-based-procedural-placement-in-horizon-zero-dawn)
and the [official TSL terrain example](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_tsl_procedural_terrain.html)
as principles, not imported code or assets.

- [x] Capture the asymmetric physical-basin trial with real terrain, resources,
      docks and four native views; preserve failed evidence and all original caps.
- [ ] Prove fourteen simultaneous anglers plus seven additional overflow players,
      all twelve catches, tier/tool/consumable rules and dry shore access at every
      tier. Repeat occupied relocations, cancellation, departure and re-entry;
      keep through-routes open with no overlapping required stances.
- [ ] Verify both distinct docks, bank transactions and collision-free circulation
      including supplier/bank journeys, concurrency, reconnect/restart and
      sustained actual gameplay. Historical v4/v6 occupancy cannot qualify v8.
- [ ] Refine shore habitats, natural transitions and dock/pavilion character;
      qualify sustained frame/loading/memory budgets and real streaming separately.

Native48 closes its owned browser; runtimes29/30 stop with temporary databases
removed and protected human localhost/artifacts unchanged. Unmount without an
observed error is not GPU reclamation proof. All LAYOUT-01–08 remain OPEN.
No default promotion, merge, deployment, smooth-travel or AAA acceptance.

Evidence: service-layout pond-headland-docks01/grass01–02/authority01–03,
stock-regression01/fishing-stock01–02/fishing-catalog01–02/v7-grass-regression01/
dense-final01/types01–02/root-lint03/root-format03/study-source01; inland pond
assets-v8/build25/runtime29–30/native48. Failed grass01, authority01 and the
mixed-fixture catalog01 invocation are retained.

### Eastern shelf groundcover trial and startup variability — 2026-09-21

Assets-v9 changes only the mapped eastern shelf's groundCover emergence/full
height from 0.08/0.20m to 0.04/0.12m. The southern headland, cutbank, physical
terrain, water, docks, bank, routes, fishing and 28 habitat instances stay fixed.
The tracked additive study is not a default override. Build25 is reused only
after all 973 production source inputs and 145 protected artifacts reverify.

Two real TerrainSystem/RoadNetworkSystem owners compare the actual v8/v9
manifests with the native selectors (including omitted coastBlend). All 70,225
height/normal/water samples and 26 roads/segments/raw road mask stay exact;
69,382 samples outside the permitted material-change domain remain exact.
767 samples gain material/CPU placement support, confined to sector 1 and the
existing +0.03…0.21m emergence envelope. Positive-support locations remain
53,830, so this is not 767 additional roots or proof of visible new blades.

Actual near-LOD worker/retained-mesh/exhaustive-oracle grass checks pass for both
affected cells. Southbank retains 966/1,009 clumps with the exact v8 output hash,
935,622 work units and 157.722ms cumulative CPU active. Eastbank retains 943/991,
796,087 units and 126.918ms. Original 1M-work/250ms-active limits remain unchanged.
Selected v9 dock/native-PhysX/layout plus exact catalog/resource tests pass 24;
202 existing composition/TSL/actual-worker regression cases pass. Counts overlap.
Full shared plus three changed test roots: 708 roots/2,384 files, zero diagnostics
and stable pins; scoped lint/format pass.

Native49 remains FAILED: at the original 90s deadline terrain was 29/29 ready,
grass 107/122, with fifteen unfinished jobs and zero observed failed jobs.
Fourteen jobs had not started and were mainly distant LOD1 cells. No matched
pond views were captured. The known cow errors also exposed a private harness
cleanup ordering problem: evidence validation could skip React unmount.
Cleanup now attempts evidence, unmount and bounded frame drain independently;
failure cannot become approval. Browser closure still completed in native49.

Native50 is explicitly ART_INSPECTION_ONLY_NO_ACCEPTANCE. It passed the original
90s startup gate, did not use its separately labelled post-deadline allowance,
and captured all four held views. Camera grass gates took 29.829/13.239/6.780/
12.176 seconds, with empty final queues, no observed failed jobs and 5.4ms
maximum observed individual slice. All fourteen fishing entities (two per
family) remain present. Source/manifest pins and served framework match; only
the exact user-deferred cow failures are admitted. Camera/clock restore, root
unmount and browser closure complete. This does not erase native49's failure
or prove seamless travel, GPU reclamation, full assets, streaming or performance.
The machine changed from battery to AC during this work: these are not controlled
performance comparisons. The material change is not established as the timeout cause.

Four-view visual review finds a modest, localized grass-to-water improvement.
The wider brown collar, submerged substrate, sparse habitat groups, plain timber
and bank approach still fall short of the intended art bar. Do not call the
shoreline solved or promote v9. The same 28 assets can next be composed into more
legible unequal cove groups, retaining complete root/rock/dock/access checks.

- [x] Bound the eastern shelf material/grass trial without changing terrain,
      physical access, recipe budgets or quality settings.
- [ ] Resolve startup/transition variability: install bounded grass-work
      observations before admission, then compare matched v8/v9 startup runs
      with unchanged deadlines, 2ms/8,192-resumption allowance and visual settings.
      Measure operation-bound versus time-bound yields, rework and phase cost.
- [ ] Continue natural bank habitats and characterful docks/pavilions; keep
      fourteen live anglers plus seven overflow, all-tier catches and bank/
      supplier routes as separate unpassed gameplay requirements.

Runtime31 and both owned browsers are closed; its temporary database is removed
and protected human localhost/artifacts are unchanged. All LAYOUT-01–08 remain
OPEN. No canonical promotion, merge, deployment, AAA or production acceptance.

Evidence: service-layout pond-shelf-groundcover01/grass01/selected-access01/
composition-regression01/build25-reuse01/types01/lint01/format01; inland pond
assets-v9/runtime31/native49–50. pond-shelf-docks-fishing01 is a stock-only dock
regression despite its broad name, not selected v9 or fishing evidence.

### Startup grass throughput traced on both pond candidates — 2026-09-21

This is diagnostic progress, NOT a loading fix, new art acceptance or promotion.
Native51 (assets-v8) and native52 (assets-v9) use identical build25, private real
GameClient/server, Chrome/Metal WebGPU, render selectors and unchanged original
90s startup/250ms polling. Power remained AC. No held camera/daylight, density,
resolution, shadow, scheduler allowance or deadline change was applied.
Native49's earlier failed loading gate remains unresolved and retained.

The private observer now attaches inside that existing gate, as soon as the
actual grass manager/renderer exist. It never advances jobs, calls isCurrent,
changes readiness or writes GPU resources. Default post-startup review mode is
preserved. Existing 2,400-frame/4,800-slice/512-job historical array caps remain;
startup aggregates continue with explicitly disclosed first-N omissions. Live
owner/scan/counter/phase-bucket loss invalidates the receipt. Neither run omitted
samples or overflowed. Both attached with zero existing jobs; preattachment
world/terrain work is not measured. All installed hooks restore exactly.

Both original gates passed: 75.257s for v8, 67.118s for v9. These single
instrumented observations are NOT a controlled speedup or performance approval.
Both reach 122 completed cells (96 installed, 26 ready-empty), zero unfinished
queues and no observed grounding failures. Fourteen distinct fishing entities,
two per each of seven families, remain present. This is not fourteen live
anglers, successful catches, unique standing places or route qualification.

| Observed grounding | v8 / native51 | v9 / native52 |
| --- | ---: | ---: |
| Manager calls / actual advance calls | 2,260 / 1,876 | 2,060 / 1,749 |
| Total resumptions / active-slice elapsed | 12,006,904 / 3,282.3ms | 11,804,730 / 2,924.9ms |
| Still-running operation-bound exits | 746 | 905 |
| Still-running below-cap deadline-observed exits | 965 | 687 |
| Final 122 successful jobs' resumptions | 10,708,658 | 10,712,919 |
| Waiting-support / cancelled jobs | 36 / 34 | 30 / 26 |
| Nonpublishing resumptions / active time | 874,586 / 328.5ms | 770,256 / 179.9ms |

A terminal status takes precedence; an exhausted explicit operation allowance
takes precedence over a coincident observed deadline crossing. Counters count
generator resumptions, not geometric work units. Slice elapsed time includes
GC/preemption, not measured CPU utilization. Boundary phase pairs may contain
other phases and cannot establish exclusive function costs. Inter-call gaps
and renderer frame labels are not FPS or exclusive idle measurements.

Nonpublishing work is 7.28%/6.52% of resumptions and 10.01%/6.15% of active time.
Most cancellations never advanced (33 of 34 in v8, all 26 in v9). Waiting jobs
were not repeatedly advanced. Seven/five earlier ready results were genuine
temporary publications, not automatically waste. Each key ultimately completes;
both runs retain a fixed focus and no LOD swaps. Final successful v9 work adds
only 4,261 resumptions (+0.040%); the shelf material change is not established as
the cause of the old timeout. Most cost remains successful-core grounding.
Exact waiting reasons/invalidation causes are not captured by these receipts:
the underlying defer reason lives in state.result.reason, not state.reason.

Private capture finalization now verifies the served framework even after a
startup failure, and browser-close failure cannot bypass final pin/report writes.
Exact deferred cow identities can be collected before failed-startup unmount.
Both native runs validate exact source/manifest pins, known-cow-only errors,
unmount and owned-browser closure. Failure-path branches are source-reviewed,
not newly exercised by these two successful runs. No GPU-reclamation claim.

- [x] Collect and reconcile startup scheduling evidence on both candidates
      without extending admission or reducing visual quality.
- [ ] Optimize measured successful-core grounding under unchanged output,
      ownership, geometric-work, resumption, slice and active-time contracts.
      Compare actual retained meshes/exhaustive oracle before native rechecking;
      do not merely repeat loading until a green run appears.
- [ ] Keep natural habitats, characterful docks, all-tier catches, fourteen live
      anglers plus seven overflow, and bank/supplier routes open for qualification.

Evidence: inland pond runtime32/native51 and runtime33/native52, including
startup-grass-budget-ledger.json and archived helper sources; service-layout
pond-startup-build25-reuse01 and pond-startup-ledger-accounting01. All 973
production inputs and 145 protected artifacts reverified before build reuse.
Runtimes/browsers are terminal, both temporary databases removed, protected
localhost:3333 preserved. No production source changed in this diagnostic.
All LAYOUT-01–08 remain OPEN; no stream, AAA, launch or default acceptance.

### Exact two-interval grass ordering — 2026-09-21

A bounded production optimization replaces the two-element merge/scratch/copy
sequence with the identical stable comparison and at most two reference stores.
The pair is job-local and cancellation remains before mutation. Larger lists
retain the original resumable merge sort. No blade/instance/texture/terrain,
density, LOD, render quality, geometry tolerance, work-unit cap, scheduler
allowance or deadline changes. Independent frozen oracle code/goldens stay
unchanged. This reduces actual generator work; it does not establish a CPU,
loading-time or FPS improvement.

Actual assets-v9 near and startup-LOD1 pond fixtures compare complete output
arrays, dependencies, provenance, semantic receipts and frozen per-clump
exhaustive numerical results. New startup cases use the real physics-backed
ProceduralDocks owners and their exclusions, matching native52's 1,009/974
south and 994/948 east input/retained clumps. Their historical native operation
totals remain context, not a requirement that the offline lifecycle match.
Original near cases retain their previous lifecycle.

| Actual cell | Complete pipeline before → after | Resumptions saved | Output |
| --- | ---: | ---: | --- |
| Near south | 373,707 → 349,447 | 24,260 (6.49%) | identical |
| Near east | 304,243 → 284,943 | 19,300 (6.34%) | identical |
| Startup LOD1 south | 211,533 → 199,357 | 12,176 (5.76%) | identical |
| Startup LOD1 east | 170,560 → 160,800 | 9,760 (5.72%) | identical |

Every savings total is exactly four per observed interval pair. All other
phase counts, triangle visits, geometric work units and all four full-output
hashes are identical. Elapsed CPU samples are mixed, not a speedup claim.
The numerical GPU/storage suite is not native GPU proof.

Final verification: 241 generic cases pass; four actual pond cases pass with
three historical-overlay cases intentionally skipped. Full shared plus changed
regressions typecheck with zero diagnostics; scoped lint and format pass.
The new five generic cases exercise ordering, tiny slices, cancellation,
invalidation and the larger-interval fallback. The signed-zero cases retain
their frozen geometry hashes and account only for observed pair savings.

Failed test receipts are retained: the new dense fixture initially lacked
surface coverage and was corrected with a larger real domain plus independent
vertex-envelope checks; the pond fixture initially missed actual dock owners.
A combined run incorrectly applied the pond-only asset overlay to a historical
plaza fixture and failed its missing-zone setup. Final runs use each suite's
required asset context; assertions were not relaxed. Cleanup attempts every
owner, preserves original errors and aggregates secondary failures after finally.

Native53's prior page-main-thread CPU sampling preserved the original startup
gate and completed in 74.475s. It excludes worker/GPU costs. Sampled grounding
ancestry is about 2.37s of the 79.71s profile; sortedIntervals self samples are
only about 15ms. Thus sorting is not established as the dominant CPU bottleneck.
Vite served-source offsets were not saved for line-level mapping; no raw local
bundle line attribution is claimed.

Native54 uses isolated build26/assets-v9 in real headful Chrome/ANGLE Metal,
1280×720 at DPR1, 4 samples and the same rendering preferences. Original
startup passed in 68.221s; the four original 30s grass camera gates completed
in 23.513/10.322/4.325/11.162s (overview/landing/jetty/bank). All end with empty
work queues and fourteen fishing entities, two per family. This single art
capture is not a controlled timing comparison with earlier instrumented runs.
The earlier startup failure is not declared fixed.

All four PNGs were visually inspected. Grass coverage is intact; the uniform
brown shoreline collar, broad homogeneous submerged toe, crosshatched/repetitive
dock timber and sparse disconnected habitat still fall short of the art bar.
The bank pavilion's grassy approach also still needs composed playable use-space.
No new unadmitted console/network error occurred; the explicitly deferred cow
still accounts for one missing request/five known events, not an accepted
visible placeholder or full asset acceptance. Camera/clock restored, actual
GameClient unmounted without observed destruction errors, test browser closed,
runtime35 stopped and its temporary database removed. All 973 build inputs,
145 protected artifacts, six build inputs and the retained lock were reverified;
human localhost:3333 remains unchanged.

- [x] Reduce exact two-interval ordering work and verify unchanged output,
      cancellation, dependencies, provenance and original bounded contracts.
- [ ] Qualify startup/frame-time reliability across repeated and moving scenes;
      the earlier native49 timeout remains retained and unexplained.
- [ ] Next visual slice: break the continuous brown shoreline collar using
      pond-local substrate composition and existing soil/rock samples, without
      changing terrain, water, grass eligibility, density, routes or capacity.
- [ ] Keep characterful docks, habitat continuity, twelve fish types across
      seven families, fourteen live anglers plus seven overflow, dry access,
      live catches and bank/supplier routes open for actual qualification.

Evidence: service-layout pond-interval-baseline03, optimized01, accounting01/02,
final-generic01, final-pond01, types02, lint02, format02 and native-accounting01; inland pond
build26/runtime35/native54 and native53 startup.cpuprofile. Test fixture-only
failures stay in their original receipts. All LAYOUT-01–08 remain OPEN; no
AAA, stream, gameplay-capacity, sustained performance, launch or default
promotion is asserted.

### Pond substrate trial rejected; cutbank coverage retained — 2026-09-21

The remaining-soil-to-rock trial is NOT accepted and has been removed from
production source. All four native57 views were inspected: the shoreline still
reads as a continuous brown collar. The added mask really compiled into the
native terrain shader, but visual improvement was insufficient to justify its
extra arithmetic. The two production files and two existing material tests
are restored exactly to the preceding checkpoint; the trial-only test and
patch are preserved privately with build27/native57. No default was promoted.

Useful regression work is retained: a real northwest-cutbank LOD1 cell with
726 input/699 retained clumps, actual dock physics/exclusions, four retained
terrain leaves, frozen exhaustive grounding checks, and separate hashes for
every worker/projected/full-pipeline attribute and grounding/provenance array.
Across five cells the trial preserved population, transforms, normals, grass
tints, visibility, root corrections and grounding exactly; only cutbank ground
colors changed. Runtime-specific owner UUIDs are not cross-owner equality
claims. No independent geometry oracle or production budget was changed.

The candidate native receipt resolves all seven real terrain texture owners
to their actual native bind groups and compiled WGSL arguments. It records
33 direct fragment texture-sampling call sites, zero vertex sites, the actual
shader files and admitted asset digests. These are static call sites, not GPU
execution counts or cost. The failed baseline never reached this receipt, and
native54 did not capture terrain shaders, so native sampler parity is NOT proved.

Native55/build26 passed startup in 86.355s but failed the original 30s overview
transition. Its last valid observation still had two grounding jobs/two LOD
swaps; frames and 277 scalar reads continued. The later snapshot had one job.
This is incomplete work at deadline, not evidence of a sustained browser hang.
Native56 failed a server-health preflight before any browser/startup gate because
the new private runtime was not ready. That orchestration failure is retained.
After explicit HTTP/database readiness, native57/build27 passed startup in
89.756s and the four camera gates in 27.065/12.839/4.211/11.160s. Every completed
view had fourteen fishing entities, two per family. No deadline, density,
resolution, shadow or scheduler setting changed. These runs establish neither
reliable loading nor a controlled performance improvement.

Source and actual WGSL expose a plausible limiting mechanism: before final
bank composition, the rock layer is itself blended with dirt by sea-relative
coastal shading. The pond waterline's normalized elevation is about 0.708,
inside that blend's transition. The blend fades out on steeper slopes, so it
must not be blamed for every bank pixel. Pond wetness darkens rather than
independently recoloring rock. The trial also affected only one feathered
cutbank sector, leaving most of the perimeter unchanged. Next: inspect/reduce
that nested soil contribution locally, coherently across all four PBR channels
and the CPU palette; preserve ordinary coast behavior and grass/road contracts.
The existing raw rock is also warm, so another visual trial remains necessary.

After restoration, 174 material/macro tests pass and full shared plus retained
tests typecheck with zero diagnostics. Concurrent material/type/pond checking
exposed an unchanged southbank active-CPU-cap failure at 250.294ms; four other
pond cases passed. A separately recorded serial pond run passed all five active
cases (three historical-overlay cases skipped), with unchanged caps. The
concurrent failure remains evidence of load sensitivity, not erased by the
serial result. Earlier native49/native55 readiness failures remain unresolved.

An execution-environment interruption ended old Node processes, including the
human game, while leaving its persistent database intact. The normal player
was recovered on localhost:3333 using the same saved character, database,
asset overlay and canonical bundles. Diagnostic runtime36's orphaned temporary
database was removed by exact identity. Runtime37/38 and their temporary
databases are now closed/removed; native55/57 restored camera/clock, unmounted
GameClient without observed destruction errors and closed their owned browsers.
The recovered human processes remain running. No user database or source was
deleted. All 145 protected compiled artifacts and six build inputs remain intact.

- [x] Add actual cutbank and per-attribute grounding regression evidence.
- [x] Reject/archive an ineffective visual trial instead of promoting it.
- [ ] Resolve nested inland soil/rock composition and qualify the result visually.
- [ ] Resolve startup/transition and CPU-budget reliability under realistic load.
- [ ] Improve dock timber grain/board contrast with unchanged collider geometry;
      the visible merged mesh is also the collider, so silhouette work is separate.
- [ ] Keep all-tier catches, fourteen live anglers plus seven overflow, dry
      access, natural habitat, bank/supplier journeys and LAYOUT-01–08 OPEN.

Evidence: service-layout pond-substrate-material03, worker-baseline01,
worker-candidate01, worker-accounting02, checkpoint01, restored-material01,
restored-pond01, restored-pond-serial01 and restored-types01; inland pond
build26/27, runtime36–38, native55–57, terrain-material-receipt.mjs and
substrate-trial01-rejected.patch. The checkpoint accounting preceded intentional
trial restoration. Final restoration01 reverified all 973 production inputs
against build26 and all five cells' arrays, including restored ground colors;
retained-lint01 and retained-format01 pass. No AAA, streaming, live fishing-capacity, sustained
performance, launch or default acceptance is claimed.

### Paired shore and timber candidate — loading gates still open — 2026-09-21

A new source candidate pairs the earlier localized remaining-soil transfer with
attenuation of dirt nested inside the rock layer. CPU ground color and all four
PBR channels share the same bounded mask; original coastal-ground/wetness and
grass support remain unchanged. This supersedes the archived transfer-only
experiment, but is NOT visually accepted. Actual terrain sampling showed why
the extra effect is limited: flatter flanks contain nested dirt, while the
steeper central face already has none; the existing rock is itself warm brown.
The native59 diagnostic overview still reads as a broad brown shoreline.
Do not repeat small shader-strength adjustments as the next art strategy.

Dock timber now reuses existing broad noise to vary member-local growth rings
and narrows combined board-color contrast. Geometry, collision, draw/material
counts and texture lookups are unchanged. This is an unqualified source
candidate, not a claim that the docks now meet the art bar. References:
[Three wood material source](https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/jsm/materials/WoodNodeMaterial.js)
and [Three procedural terrain](https://threejs.org/examples/webgpu_tsl_procedural_terrain.html).
No package update or expensive reference shader was copied wholesale.

Verification: 181 material/macro/substrate tests and 19 actual dock geometry,
physics, routing and lifecycle tests pass; full shared plus all nine explicit
changed source/test files typecheck with zero diagnostics. The first pond run
passed three cases but failed southbank/cutbank at the unchanged 250ms active
limit (250.442/256.198ms, cutbank maximum slice 80.027ms). These failures remain.
A misleading aggregate hash label was corrected: the earlier core result and
completed timed result are now separate; incomplete timed jobs have no output
hash. A new run to validate that report passed five cases (three historical
overlay skips), with identical operations and all geometry/support arrays;
only raw/projected/final cutbank ground colors changed. This later pass is not
proof of loading reliability and does not erase the earlier failures.

Fresh fixed native pair: baseline native58/build26 failed the original 90s
startup with 107/122 grass cells ready. Candidate native59/build28 loaded in
88.449s, then failed the original 30s overview transition. Zero accepted review
views were produced by this pair. The bounded post-failure receipt proves the
candidate mask in actual WGSL and seven texture-role bindings/33 static fragment
sample sites, not exact pond pixels, dynamic GPU cost or baseline sampler parity.
Both failures show unfinished grass queues rather than failed-budget jobs.
Substantial concurrent host activity was observed; causal attribution is open.
Quality settings, deadlines, density, resolution and work limits are unchanged.

- [x] Preserve exact CPU/TSL support contracts and distinguish failed-job evidence.
- [ ] Resolve grass startup/transition reliability before more visual complexity.
- [ ] Fully review the timber candidate at both dock eye-level views and in motion.
- [ ] Recompose existing northwest bank plants into a visible asymmetric drift;
      retain model/count/scale budgets and prove root, dock and fishing clearances.
- [ ] Keep the whole-shore art review, all-tier catches, fourteen anglers plus
      seven overflow slots, dry routes, bank and supplier journeys, and LAYOUT-01–08 OPEN.

Evidence: service-layout pond-rock-treatment material01, pond01, receipts01,
types02, checkpoint01, final-lint01/final-format01 and host-load01; dock-timber-
polish-tests03; inland pond build28, native58/59 and runtime39/40. Both owned
browsers closed, GameClient unmounted with zero observed destroy errors, and
both temporary databases were removed. Human localhost:3333 and its persistent
database remain unchanged; all 145 compiled artifacts/build inputs are intact.
Source is retained only as a reviewable work-branch candidate: no default,
streaming, sustained performance, AAA or launch acceptance.

### Finer terrain lookup and bank drift — native startup still open — 2026-09-21

A reviewed source candidate keeps the existing eight-face terrain broad filter
and adds separately charged four-face child tests only after a qualified parent
hit. Numerical envelopes, exhaustive fallbacks, face order, ownership checks
and clipping are unchanged. No deadline, work limit, density, resolution or
shadow setting was relaxed. The earlier wind-product micro-optimization was
rejected after alternating real-core A/B measurements showed no consistent
benefit; production wind code is restored, with two useful regression tests kept.

Five actual pond cells preserve all 100 worker/projected/completed-buffer hashes
against pond-rock-treatment-receipts01 (only owner UUIDs differ). Triangle visits
fall 36.6–40.1%, but charged resumptions fall only 2.4–4.5%; child tests are not
free. Four unique pond owners add 2,131,648 bytes of metadata, from 1,323,904 to
3,455,552 bytes. Each owner adds one preparation yield. These are exact CPU
payload counts, not total game/GPU memory or a performance acceptance claim.

| Pond cell | Prior active ms | Candidate active ms | Candidate max slice ms |
| --- | ---: | ---: | ---: |
| Near south | 222.992 | 153.499 | 2.328 |
| Near east | 139.805 | 118.913 | 2.279 |
| LOD1 south | 102.904 | 89.282 | 2.068 |
| LOD1 east | 104.659 | 78.534 | 2.257 |
| LOD1 cutbank | 89.535 | 78.608 | 2.384 |

These are separate historical executions, not a controlled paired speedup.
First southbank admission increases 68.317→89.474ms; the other four totals
decrease. Admission maximum-step timing is absent from both receipts and the
native pair. Query savings do not qualify preparation tails or live memory.

The northwest planting recipe moves only seven existing plants across a 6.6m
asymmetric drift. All 28 instances, models, scales, yaws, rocks and the other
21 placement objects are preserved. Selected pond support/clearance, dock BFS
and fishing dry-approach/ecology checks pass, but no candidate view completed:
the drift's visual quality remains unverified.

Final checks: 184 terrain/grounding/habitat tests pass; five actual pond tests
pass (three historical-overlay skips); three selected dock BFS/publication and
fishing ecology tests pass; one selected-assets habitat test passes. Full shared
plus six explicit
source/test roots typecheck with zero diagnostics (709 roots/2,384 source files);
scoped lint/format pass. The first types run caught a missing-height narrowing
in the test setup, now corrected without a cast/default. An incorrect selected
test filter skipped everything; only the corrected selected-final02 run counts.

Build29 pins 973 production inputs; only the terrain lookup, habitat owner and
habitat JSON differ from build28. Baseline native60/build28 passed startup in
77.047s and all four camera gates (27.933/11.701/4.528/10.558s).
Candidate native61/build29 FAILED the unchanged 90s startup: 118/122 grass cells,
29/29 terrain chunks and water ready; two observed remaining grounding jobs,
one not yet started, with no failed-budget/waiting-support jobs. Zero candidate
review views. Earlier native58/59 and CPU failures remain retained. Concurrent
host activity is a confound, not established causation or an excuse to accept.

Baseline visual review still finds a continuous brown pond collar, planting
swallowed by meadow, and an unfinished grassy bank-pavilion arrival. The next
art proposal is a pond-wide mineral/silt/turf composition using existing
height/slope/sector fields and existing samples, with shared CPU/TSL treatment.
Use [Three's terrain source](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_tsl_procedural_terrain.html)
for broad height/slope material hierarchy; no wholesale shader replacement.
This is not implemented or visually approved.

- [x] Preserve exact terrain/grass results while reducing unnecessary triangle tests.
- [x] Add placement-only drift and real selected support/route regression checks.
- [ ] Qualify admission tails, live metadata cost and native startup/transitions;
      the finer lookup is a branch candidate, NOT a proven loading fix.
- [ ] Visually qualify the plant drift and both timber closeups/in motion.
- [ ] Replace the uniform pond collar with legible mineral/silt/turf masses,
      preserving geometry, wetness, all-tier access and sampler budgets.
- [ ] Give the bank pavilion a readable maintained arrival and footing.
- [ ] Keep all-tier catches, fourteen live anglers plus seven overflow, bank
      and supplier journeys, and every LAYOUT-01–08 acceptance gate OPEN.

Evidence: service-layout grass-wind-ab01/summary01, grass-mutable-wind01,
grass-child-blocks-core01/pond01, grass-child-drift-finaltests01/types02/
finallint01/finalformat01, pond-drift-route-gates01 and selected-final02;
inland pond build29, native60/61 and runtime41/42. Both owned browsers closed,
GameClient unmounted without observed destruction errors and both temporary
databases removed. Protected human localhost:3333, its persistent database and
canonical artifacts are unchanged. No default, streaming, sustained-performance,
AAA or launch promotion; source remains an unqualified work-branch candidate.

### Pond material families and frame-coupled grass loading — 2026-09-21

The pond now has a SOURCE CANDIDATE for lower-chroma mineral cutbanks/turf toes
and darker sheltered silt, using existing sampled soil/rock detail and admitted
sector/height fields. CPU ground colors and TSL share the same grade; normal,
roughness and AO contributions follow the same material families. Coverage,
grass eligibility, geometry, raw relief/cavity inputs, coastal soil and final
wetness remain unchanged. The graph retains the same 33 sampled-node identities;
that is NOT a measured GPU-cost guarantee.

Final verification: **185 material/substrate/macro tests pass**, including a
complete 18-case mean-color assembly comparison and isolated minified-worker
execution. The first run caught an external keepNames helper captured by named
arrows; internal object methods fix it, and the original failed receipt remains.
Five actual pond grounding cases pass within unchanged caps (three historical
overlay skips). Against grass-child-blocks-pond01, **91/100 attribute hashes are
identical and only nine ground-color hashes change**; all non-color array values,
counts, bounds and visibility match, apart from expected owner UUIDs.
Full shared plus seven explicit roots typecheck with zero diagnostics
(709 roots/2,386 files); scoped lint and format pass. New CPU admission timing
includes first/terminal resumptions: maximum observed step 0.700ms and maximum
edge-index step 0.430ms in these cases, not native or universal bounds.

**Native acceptance remains FAILED.** Build30 pins 973 inputs and changes only
the three material production files from build29. Native63 passes original
startup in 71.229s, then fails the unchanged first 30s camera-transition gate
with three grounding jobs still running; zero completed review views.
Its failure image shows a clearer pale mineral face, but the pond still reads
too much as a continuous collar, small planting is weak at overview scale, and
the pavilion arrival remains unfinished. A post-failed-cut material receipt
and failure image are diagnostic evidence only, not visual approval. Earlier
native61/startup and other failures remain retained.

Native62 is a separate read-only startup observation of build29, not a successful
A/B performance trial: 57.660s startup, 11,353,977 grounding resumptions,
2,696.8ms active work over 48.6075s between manager-call starts. Work advances
once per game tick under the existing 2ms/8,192-resumption allowance; the
configured profile is 60FPS and no frame-pacer defect was established.
208 complete/restored terrain polls cost 32.0ms total (5.7ms maximum).
Observed index payload peaks at 3,455,552 bytes across four indexed owners among
55 retained surfaces. Hypothetical geometry/topology copy inputs total
9,252,164 bytes; this is NOT actual worker/whole-heap/GPU allocation.
The whole terrain preparation maximum step is 6.600ms at
collar_cell_plan → collar_sliver_balance, not an admission-only maximum.

- [x] Implement and verify coherent local material families without extra sampling.
- [x] Measure bounded resident index payload and preparation maxima; preserve failed gates.
- [ ] Implement a bounded exact-fitting worker, beginning with a private bundled
      real-module entry and one retained-cell parity test, then all five pond cases.
      Copy borrowed geometry; never transfer live renderer buffers. Preserve
      source identity, dependency mapping and cumulative work/time accounting.
- [ ] Add bounded reservations/cache ownership, cancellation/failure/stale-response
      tests and actual copy/transfer costs; then integrate publication without
      changing main-thread admission, lease checks or one-upload/frame policy.
      Do not reuse the unbounded generic WorkerPool unchanged.
- [ ] Re-run original startup/camera gates and closeup/motion art review after
      that implementation; do not retry merely for green or raise limits.
- [ ] Finish pond-wide composition, readable bank-pavilion arrival, planting
      and both dock closeups. All seven fishing families, fourteen live anglers
      plus seven overflow, dry routes, bank and supplier journeys, and every
      LAYOUT-01–08 acceptance gate remain OPEN.

Worker transport design follows [MDN's transfer semantics](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects):
transferring an ArrayBuffer detaches its original owner, so renderer-owned
storage must not be transferred. This does not itself prove our worker design.

Evidence: service-layout pond-appearance-tests01/tests02/worker02/grounding01/
buffer-compare01/types01/lint01/format01/build30; inland pond native62/63,
runtime43/44 and build30. Both owned browsers closed and temporary databases
were removed; protected human localhost:3333, database and canonical artifacts
are unchanged. No default, stream, sustained-performance, AAA or launch approval.

### Exact-fitting worker and bounded retained-terrain reuse — 2026-09-21

**SOURCE CANDIDATE ONLY; not connected to gameplay or promoted.** The real
GrassBladeGrounding/TerrainGridSurface modules now run in a self-contained
browser-target bundle, tested through an actual Node worker transport.
Borrowed geometry is copied in guarded 1,024-element batches, preserving its
original identity, attribute versions, index width and topology. Live renderer
buffers are never transferred. Consumed work can cross execution boundaries
without resetting the existing 250ms / 1,000,000-operation fitting limits.

The first monolithic pond trial FAILED four of five cases at the unchanged
250ms limit. Bounded phase attribution measured 147.987ms spent reconstructing
two southbank owners before fitting. The original game already admits retained
terrain once before grass jobs; rebuilding it for every worker fit was redundant.
The candidate now has explicit, separately measured prepare_surface,
start_cached and release_surfaces lifecycles. Each immutable owner is admitted
once under its own unchanged 2ms/8,192-operation slices and 250ms/1m total cap.
There is one active task, no internal FIFO, lifetime-monotonic task/owner IDs,
and at most sixteen cached owners. Preparation/cancellation/failure rolls back
partial ownership; cached fits cannot dispose terrain held by the cache.
Review caught and fixed release acknowledgement ordering before verification.

Final CPU verification: **489 tests pass** across snapshot/core (245), existing
manager/cells/pacing/same-face regressions (190), actual worker transport/cache
(49), and the five real pond cases (three historical-overlay skips).
Twelve numerical cases cover cold and repeated cached fits. Tests verify exact
arrays/dependencies, transfer isolation, seeded limits, cancellation, stale IDs,
malformed input, rollback, release/recovery and aggregate reservation rejection.
All five pond fits equal the real core; full pipeline/oracle/provenance assertions
remain in place. All 100 completed-pipeline buffer hashes match the prior
pond-appearance-grounding01 receipt; only expected owner UUIDs differ.
Full shared plus nine explicit source/test files typecheck with zero diagnostics
(712 roots / 2,388 source files). Scoped lint and formatting pass. The first
lint run found an undeclared global warning; explicit globalThis.MessageChannel
fixes it. The final frozen worker/pond run passes all 54 cases again (three skips).
The following measured timings are from cache-pond01, not a universal bound.

| Actual pond case | One-time preparation active ms | Fitting active ms | Total active ms | Cold wall ms including worker boot/copy/preparation/fit |
| --- | ---: | ---: | ---: | ---: |
| Near south | 125.124 | 215.397 | 340.522 | 366.780 |
| Near east | 108.842 | 162.719 | 271.561 | 297.008 |
| LOD1 south | 125.114 | 131.148 | 256.262 | 281.744 |
| LOD1 east | 110.317 | 110.171 | 220.488 | 246.464 |
| LOD1 cutbank | 172.478 | 102.973 | 275.451 | 305.527 |

These are individual Node-worker observations, NOT native frame/loading
qualification or a controlled speedup. Preparation is not free or erased:
total cold costs above include it. The monolithic cold diagnostic still fails
four cases in the final run and is explicitly not an accepted execution mode.
The original failed receipts are retained; attribution01 selected no tests and
does not count. Corrected attribution02 measured the southbank failure.

Cached fitting transfers 48,600–70,672 input bytes in these cases, versus the
cold path's 4.3–7.2MB. The largest tested retained region has four owners,
7,116,188 copied-input bytes and 11,518,272 reserved index/topology bytes.
Aggregate cached+in-flight input and retained metadata reservations each cap
at 16MiB; result payload caps at 2MiB. These are NOT total worker memory:
validation/fitting scratch, JS metadata and whole-heap peak remain unqualified.
The fixture measures copying but is not a production main-thread copy scheduler.
The final near-south fit used 233.668ms, leaving only 16.332ms of the original
cumulative fitting cap for main preparation/remapping. End-to-end headroom
must be demonstrated during integration; a passing isolated fit is not enough.

- [x] Prove exact isolated worker execution, guarded copies and cumulative accounting.
- [x] Implement/test explicit bounded owner reuse, cancellation and release.
- [x] Pass all five real pond fitting cases without geometry/density/cap changes.
- [ ] Add bounded main-thread transport/preparation and explicit waiting state;
      preserve projected provenance, complete input/region leases and byte ownership.
- [ ] Map returned dependencies only to held owners; reject replacement, newly
      arriving neighbors, stale constraints/LOD and late same-key responses.
      Resume provenance remapping under the same cumulative fitting budget.
- [ ] Integrate one-upload/frame publication and cancellation/teardown across all
      manager exits. Qualify aggregate scratch/heap and copy/transfer tails.
- [ ] Emit/watch the separate bundled worker correctly through flattened shared
      output and Vite; verify real Chrome worker behavior before native gameplay.
      Canonical build artifacts/configuration remain unchanged in this checkpoint.
- [ ] Re-run unchanged native startup/camera gates, then resume pond composition,
      planting, bank-pavilion arrival and both dock visual/motion reviews.
      Every broader LAYOUT-01–08, all-tier fishing, streaming and launch gate stays open.

References rechecked: [MDN transfer ownership](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
and [Three BufferAttribute versions](https://threejs.org/docs/pages/BufferAttribute.html).
They inform buffer custody/version guards, not acceptance of this implementation.
Evidence: service-layout grounding-worker-core01, manager-regression01,
transport01/02, pond01, pond-phase01, pond-attribution01/02,
cache-transport01, cache-pond01, cache-buffer-compare01, cache-types02,
final-tests01, final-types01, final-buffer-compare01, lint01/02 and format01;
all prefixed grounding-worker-. No browser or temporary database was launched
for this CPU stage. Human localhost:3333 and protected artifacts stay unchanged.
No native-performance, visual, AAA or production-launch approval.

### Grass worker handoff and native transport — 2026-09-21

**Progress, not game/visual acceptance.** Production preparation, transport and
return-path components now compose against the real five pond cells. The game
manager still uses the retained main-thread pipeline: no default/profile switch,
canonical rebuild, live cache wiring or native startup requalification happened.

- [x] Added a distinct bounded preparation continuation. It runs the existing
  constraint lease and projection, copies nine exact-sized numerical buffers in
  at most 1,024-element batches, guards blade/source revisions and keeps original
  surface references and ecological provenance on main. It never fabricates a
  ready grass result or transfers renderer-owned/provenance arrays.
- [x] Added a single-slot actual-worker client with monotonic task IDs, bounded
  acknowledged cache accounting, pre-transfer reservations, cancellation awaiting
  acknowledgement, 10-second transport watchdog and permanent transport-error
  termination. A parked result still occupies the slot until explicitly taken;
  no queue, automatic retry or detached-buffer fallback was introduced.
- [x] Added bounded return-path owner/token/revision reconciliation, numerical
  output/visibility validation and existing provenance remapping. The unchanged
  fitting allowance carries through projection, copy, worker fitting, measured
  main transport and publication. Independent review found a missing-coordinate
  bounds check; explicit six-coordinate validation and a regression now cover it.
- [x] Current verification: **346 relevant tests passed** — preparation 33,
  publication 28, client 31, worker/cache 49, actual pond 5, existing
  manager/geometry regressions 190, native browser transport 10. The five pond
  cases retain three historical overlay skips, not untested current cases.
  Final unit run passed all 141 again. Tests use actual geometry/generators,
  real worker realms and native Chrome transport, not response mocks.
- [x] All 100 completed-pipeline pond buffer hashes still match
  `pond-appearance-grounding01`; counts, transforms, roots, masks, bounds and
  ecological evidence remain exact (allocation-specific owner UUIDs excepted).
  Actual full worker-handoff output and provenance also match the original
  complete pipeline in each case.
- [x] Full shared production plus nine explicit changed/test roots: 716 root
  files, 2,490 sources, zero type diagnostics (`grounding-handoff-types05`).
  Earlier types02/types03 failures were test typing issues and remain recorded;
  fixes did not change runtime bounds or bypass validation.
- [x] Headful Chrome 153, ANGLE Metal, actual WebGPU adapter
  `apple / metal-3`: ten native transport cases pass. Cold parity, explicit
  preparation, initial fit plus two cached repeats, release and cancellation/
  recovery all use actual browser Workers. One owned context/tab and ephemeral
  loopback server were closed; every operation reports zero retained owned
  workers/clients/cache after cleanup. This is not a rendered-world test.

**Real pond full-fitting ledger** (Node worker realm; milliseconds of cumulative
active slices, not a native frame-time result):

| Actual cell | Projection/copy | Main dispatch + receipt | Full fitting/publication | Cold wall including explicit admission |
| --- | ---: | ---: | ---: | ---: |
| Near southbank | 2.906 | 0.415 | 218.667 | 372.504 |
| Near eastbank | 0.871 | 0.268 | 168.263 | 303.327 |
| LOD1 southbank | 1.505 | 0.214 | 146.618 | 318.715 |
| LOD1 eastbank | 0.933 | 0.254 | 112.473 | 248.067 |
| LOD1 cutbank | 0.867 | 0.413 | 125.998 | 311.211 |

All five full jobs complete below the original 250 ms / 1,000,000-resumption
limits. Terrain fixture capture and once-per-owner admission remain separately
measured; no free per-job warmup is claimed. The near-south result is one
observation, not evidence that the earlier 233.668 ms fitting tail disappeared.
Main transport callback sums conservatively bound that phase's maximum slice.
Native first cold dispatch measured **2.935 ms** and **5.175 ms** on the two
verification runs (postMessage **2.105 / 3.670 ms**), above the cooperative
2 ms target; it stays an open scheduling/
allocation-tail concern. Native fitting also has non-preemptible slice overshoot.
Do not turn passing functional checks into frame-time or whole-heap approval.

- [ ] Next: wire an explicitly opt-in game-manager coordinator, single selected
  prepared payload, held-object-to-token cache, source retirement/eviction and
  aggregate reservations **before terrain copying**. Include original complete
  region/constraint/LOD/ticket checks so new neighboring owners invalidate work.
  Await cancellation acknowledgement or worker death before reclaiming capacity;
  never let an old same-key response clear a replacement.
- [ ] Keep one shared main preparation/remap deadline and one mesh upload/frame;
  charge dispatch/receipt CPU and fail the original cumulative budget before
  constructing publication if already exhausted. Do not raise caps or reduce
  grass/geometry/shadows/resolution to pass.
- [ ] Package/watch the dedicated worker correctly through flattened shared
  output and Vite; qualify real cold startup, unchanged 30-second camera gates,
  queue latency, allocation tails, aggregate transient/retained memory and
  long-running movement/LOD/retirement in the isolated playable candidate.
- [ ] Then resume matched pond material/shore planting/pavilion/dock review and
  wider island art. Native63 remains the last **failed** original camera-gate
  result; no new AAA, launch, production or visual approval is asserted.

Evidence: service-layout `grounding-handoff-*` (core01, client01, pond01,
manager01, browser01/02, final-unit01, compare01, types01–05, lint01–03 and
protected01/02). Lint02's browser-global warning was corrected with explicit
globalThis access; lint03 and format01 pass. Protected artifact/build-input/retained-lock checks pass and
localhost:3333 still returns HTTP 200. No human server, DB/character, canonical
artifact, unrelated duplicate/mode/lockfile, default or dependency was changed.
Implementation follows native [worker ownership transfer](https://developer.mozilla.org/en-US/docs/Web/API/Worker/postMessage)
and [termination semantics](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate);
these references do not substitute for the actual tests above.

### Grass worker game integration and packaging — 2026-09-21

**Opt-in source candidate; no default promotion or AAA/launch acceptance.**
This supersedes the prior handoff section's next-step ownership/packaging tasks.

- [x] Actual TerrainSystem/GrassVisualManager integration behind the explicit
  `grassGrounding=worker-v1` + fine-meadow appearance/render-profile pair.
  Absent selection preserves the existing path. Density, geometry, quality,
  resolution, shadows and original 250 ms / 1m fitting limits are unchanged.
- [x] One active copied handoff, immutable held-owner cache with sixteen owners,
  pre-copy input/derived reservations, monotonic tokens, idle/stale/LRU release,
  complete region/constraint/ticket/LOD checks and one mesh upload per frame.
  Snapshot layout is O(1); renderer-owned buffers are never detached.
  Input 16 MiB / retained metadata 16 MiB / result 2 MiB are numerical bounds, NOT
  total JS/GPU heap limits. Terrain admission is separately bounded/measured;
  no per-fit budget reset or detached-input fallback.
- [x] Actual manager tests verify identical mesh attributes, cache reuse,
  cancellation of dispatched fitting, retired-owner release, and teardown.
  Review found and fixed the dormant-caller-after-worker-death reservation edge;
  a real worker-death regression covers both active and dormant job cleanup.
- [x] 747-case regression run passes; final focused ownership/client/worker/
  handoff/publication run passes 205 cases (overlapping manager/coordinator cases).
  Native Chrome/Metal factory+Vite packaging passes ten cases using the actual
  emitted worker asset. Full shared + changed tests/Vite config typecheck:
  720 roots / 2,738 source files, zero diagnostics.
- [x] Dedicated fully bundled sibling worker emitted before flattened framework.
  Development batching stages all outputs before publishing client JS last;
  only that commit signals reload. Real esbuild/filesystem/Chokidar proof verifies
  failed/stale batches preserve prior outputs and successful commit coherence.
  This does not qualify the complete long-running dev-main/typecheck/HMR lifecycle.
- [ ] Qualify sustained movement/LOD churn, cold/warm queue latency, whole-heap
  peaks, upload/GPU/frame tails and full watch-mode failure/recovery. The 2 ms
  slice target remains cooperative; individual preparation/transport tails exist.
- [ ] Continue art review: broad continuous shore collar, weak shoreline
  planting, uniform grass silhouette, plain dock timber, unfinished pavilion
  arrival/grounding and wider island composition remain below the intended bar.
  Passing ownership tests is not visual approval.

Native outcome, cleanup, final source pins and scoped checkpoint details follow
in the current development checkpoint. Evidence: service-layout
`grounding-coordinator-*`, isolated pond build32/native64–65 and final build33/native66.
Native64 reached 122/122 cells in 50.910 s and first cut 17.344 s, then FAILED because
the old diagnostic reader called a nonexistent job predicate. Its record stays
failed; the reader now reports unavailable predicates explicitly, never true.
Native65 captured all four views with no errors: startup 51.066 s, cuts
17.972/5.267/4.316/6.646 s. These pass readiness deadlines but are NOT smooth
camera/gameplay/loading acceptance or a controlled speedup. Main grounding slice
maximum 2.5 ms; admission maximum 16.7 ms includes separate remote work, not solely
main-frame time. Older transport tails remain open. Final post-review build33/native66 also captured all four views with no errors:
122/122 cells ready in 47.250 s; unchanged camera gates passed in
16.824/5.274/4.296/6.825 s. Its main grounding slice maximum was 2.4 ms and the
separately measured admission maximum 7.5 ms. These are individual observations,
not a controlled speedup or seamless movement approval. Both owned diagnostic
runtimes stopped, their temporary databases were removed, and all owned browser
contexts closed. Canonical output hashes, human ports/DB and lock remain unchanged.
The protected build-script source pin was explicitly advanced for worker emission;
the five other build-input pins and all 145 compiled-artifact pins remain exact.

References: [Vite worker asset ownership](https://vite.dev/guide/features.html#web-workers),
[worker transfer](https://developer.mozilla.org/en-US/docs/Web/API/Worker/postMessage),
[termination](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate).
The actual tests, not those references, establish the limited results above.

### Shore-family study — partial visual evidence; admission blocker retained

**World first, compact island only, one arena, SOL only.** The shoreline is not
visually accepted. Native67's overview shows only a subtle warmer turf margin;
root and independent review still reject the continuous bare ribbon, sparse
planting, uniform lawn and unfinished world composition as final art.

- [x] Candidate material-family correction: dry-turf toes no longer inherit the
  mineral grade. Cutbank and sheltered silt remain distinct. This changes composed
  albedo/roughness/AO/normal together; it is NOT an albedo-only change. Coverage,
  source maps, terrain, root support and wetness authority remain unchanged.
- [x] 159 material/substrate tests pass; final formatted substrate repeats all
  nine cases. Full shared plus explicit tests: 715 roots / 2,392 sources, zero
  diagnostics; scoped lint/format pass. Initial tuple-typing failure was fixed.
- [x] Actual archived/current factory comparison: 7,200 samples, 21,600 exact
  coverage comparisons and 7,200 exact pond/wetness results. 612 appearance
  masks differ. Four completed grass cases preserve 74/80 array hashes; only
  six ground-color hashes change. No fifth-case completed-buffer claim.
- [ ] Retained CPU regression failure: the LOD1 eastbank legacy full pipeline
  exceeds its original 250 ms cap (250.111 ms, maximum slice 18.444 ms).
  Its actual handoff-worker publication completed in 118.857 ms. Four cases
  passed, one failed, three unrelated overlay cases skipped; no cap increase.
- [ ] Native67/build34 is FAILED, not a four-view pass: startup takes 57.737 s;
  overview settles in 19.033 s with 61,453 clumps, then landing transition fails
  grass cache admission before fitting. First failed job gcell_v1_16_19 has
  zero fitting work; later failures propagate to two further jobs. The precise
  failed terrain owner and admission cost need better retained evidence.
  Admission maximum jumps 6.2 to 144.3 ms while main grounding stays 4.7 ms.
  Synchronous-slice elapsed time includes GC/descheduling; no cross-message
  waiting charge was found. Add a bounded terminal owner/token/revision,
  remote phase/work and transport receipt before one instrumented reproduction;
  do not infer an optimization or exact owner from aggregate counters.
- [x] Overview camera/phase and population match native66; exposure differs by
  9.6e-9, other recorded lighting scalars match. Natural animation is not locked.
  One usable overview does not qualify eye-level material, motion or performance.
- [x] Runtime47 and its temporary database removed; owned browser closed.
  Human localhost:3333/DB, all 145 canonical compiled outputs and lock retained.
  No source/default promotion to the playable runtime, installs or quality cuts.
- [ ] NEXT: diagnose and correct the bounded terrain-admission failure, preserving
  full work accounting and limits. Do not retry captures merely to get a pass.
- [ ] Then qualify compact single-sun shadow bias across docks, pavilion contact,
  terrain and foliage at three sunlight phases. Existing native24/26/27 controls
  attribute fine dock plaid to shadows, not timber UVs; avoid more grain tuning.
- [ ] Next substantial art pass: regroup existing shoreline plants/rocks into
  unequal connected masses with open fishing/navigation, rather than another
  tiny color adjustment. Improve pavilion arrival and grass silhouette together
  only after reliable captures and measured unchanged quality are available.

Evidence: service-layout-network01 `shore-family-*`; inland pond
`isolated-build34-report.json`, `native67`, `runtime47`.
Reference re-check: [Three procedural terrain](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_tsl_procedural_terrain.html),
[wood source](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/materials/WoodNodeMaterial.js),
[shadow source](https://github.com/mrdoob/three.js/blob/r186/src/nodes/lighting/ShadowNode.js).
The references guide material/shape separation and a shadow investigation;
neither source references nor numerical passes establish AAA acceptance.

### Bounded grass handoff and native audio — fitting budget remains open

**World-first source checkpoint only; not AAA, smoothness or launch acceptance.**
The worker route remains explicitly opt-in. No density, topology, resolution,
shadow, fitting-operation/CPU cap or native readiness deadline is relaxed.

- [x] Retain one bounded, immutable admission-failure diagnostic: exact owner,
  token/revision, local/remote phase, consumed work and final merged ledger.
  It holds no terrain/input buffers or unbounded history. Later job logs label
  it last-observed context, not necessarily that job's cause. Fitting failure
  with zero admission failure is not misreported as cache admission failure.
- [x] Coalesce positive-progress local coordinator phases within the SAME
  manager-wide 2 ms / 8,192-operation allowance. Pending remote work yields;
  active-owner priority, accounted dispatch tails, one upload/frame and
  cancellation/ownership guarantees remain. This is not a measured speed win.
- [x] 157 coordinator/snapshot/manager/pacing regressions pass using actual
  worker transport. Tests check whole-call operation accounting, dormant
  isolation, parked remote work, reservations and per-call upload bounds.
- [x] Repair the ordinary player audio unlock path: resume the real context on
  an eligible gesture without depending on absent /tiny.mp4. Duplicate gestures
  cannot double-drain; closed/destroyed owners clean up; retryable resume errors
  retain listeners. Synchronous ready-callback errors remain handled separately
  from native resume errors; historical abort-on-callback-error queue behavior
  is retained, not claimed fixed. Remove the obsolete test error allowlist.
- [x] Four actual headful Chrome/Metal audio lifecycle tests pass under normal
  activation policy, using no-gesture CDP probes and genuine trusted input.
  Includes a native invalid-stream callback error; no mocked AudioContext,
  fake clocks or audio output. Audible quality, Safari and streaming remain open.
- [x] Final source/test noEmit, scoped lint/format and nine isolated build bundles
  pass. Final build38 adds only callback-error containment after world build37;
  it is NOT a new full-world native run.
- [ ] Native68 failed the new profiler's target selection; its partial capture
  does not provide the required pair of accepted CPU profile windows.
  Corrected native69 obtains main + actual grass-worker CPU profiles for both
  original overview/landing cuts. Worker sampled idle share is 95.72%/87.29%;
  profiles include setup, GC and scheduling, not exclusive CPU or GPU timing.
  The earlier native67 144.3 ms admission spike did not recur; it remains open.
- [ ] Unprofiled native70/build35 is the four-view pre-coalescing baseline:
  startup 73.428 s; cuts 21.934/6.268/5.129/8.231 s. Native71/build36 fails before
  views on the missing-video audio path despite passing startup in 42.681 s.
  A failed run's shorter startup is NOT evidence of an overall performance win.
- [ ] Native72/build37 fails the original 90 s startup gate, with ZERO views:
  gcell_v1_15_17 LOD1 fitting uses 153,028 operations / 251.700 ms active time
  against the unchanged 250 ms limit. 121 cells complete, 26 empty, one fails.
  Maximum main slice 8.3 ms, admission 10 ms; lastAdmissionFailure is null.
  This is fitting, not admission. No audio-unlock errors recur. These elapsed
  synchronous-work measurements include GC/descheduling; do not waive the cap.
- [x] Runtime48–51 and their temporary databases are removed, all five owned
  native browsers closed, canonical outputs/lock and human localhost:3333/DB
  remain unchanged. Source pins and the eight status mirrors are checked.
- [ ] NEXT: preserve the exact failed cell as a real-terrain regression; prove
  safe reuse of existing conservative face-block bounds for height-only root
  sampling, with exhaustive fallback and exact historical output/work parity.
  Measure paired actual-worker costs, then unchanged native gates and sustained
  movement/cache retirement. Do not retry unchanged failures until one passes.
- [ ] Then qualify compact-sun shadow bias and regroup shore planting/rocks into
  larger unequal masses while protecting all fishing/dock/dry routes. The bare
  bank ribbon, uniform lawn, pavilion arrival and broader composition remain
  below the art target. No new art/default promotion, merge or deployment.

Evidence: service-layout-network01 `admission-diag-*`, `admission-cadence-*`,
`admission-audio-*`; inland pond build35–38, native68–72 and runtime48–51.
References: [Chrome Web Audio activation](https://developer.chrome.com/blog/web-audio-autoplay),
[HTML activation events](https://html.spec.whatwg.org/multipage/interaction.html#activation-triggering-input-event),
[native AudioContext resume](https://webaudio.github.io/web-audio-api/#dom-audiocontext-resume).
Actual tests establish only the limited outcomes stated above.

### Height-only terrain sampling — native gate recovery, not smoothness approval

**World first; compact island only; one arena; SOL only.** Source remains a
candidate, and the playable localhost:3333 build is not promoted.

- [x] Preserve the exact native72 failed cell (gcell_v1_15_17, LOD1) with real
  terrain, owner order, physics-backed dock exclusions and authored constraints.
  Completed baseline: 1,134 input / 1,091 retained clumps; 27,216 endpoint
  queries. The old 153,028-operation / 251.7 ms receipt is a failed prefix only.
- [x] Height-only sampling reuses existing qualified parent/child face bounds,
  with a conservative floating-point proof and original-owner validation.
  Face order, boundary ties, arithmetic, exhaustive fallback and full normal
  sampling remain unchanged; no added spatial index or bound metadata.
- [x] 578 focused sampler/grounding/snapshot/worker/manager tests plus six real
  pond cases pass. New boundary coverage includes qualified ±64 coordinates,
  neighboring doubles, signed zero, small/skinny tails and published-owner
  invalidation. Final noEmit: 724 roots / 2,745 sources; lint/format pass.
- [x] Baseline/candidate comparisons preserve all 120 array hashes, provenance
  data, populations, bounds, dependencies, geometric-work receipts, generator
  resumptions and full-pipeline operation totals across all six pond cases.
  CPU observations are mixed, not a proven speedup; cold monolithic admission
  failures remain separately recorded and are not relabeled as passing fits.
- [x] Exact build39 native73 passes the original startup and four camera gates,
  with no errors and all 122 initial grass cells ready. Startup 44.022 s;
  cuts 6.133 / 3.244 / 2.090 / 3.176 s. Camera/render settings, queues and
  populations match native70: 61,453 / 79,706 / 66,254 / 75,996 clumps.
- [ ] Not a controlled performance comparison: native70 also predates handoff
  coalescing/audio fixes, and host power/contention differs. Native73 retains
  a 28.2 ms admission slice (main grounding max 2.2 ms). Original native67/72
  failures and multi-second settling remain open; no frame-rate, sustained
  movement, heap, streaming, reliability-tail or AAA acceptance is granted.
- [ ] Strict photometric matching is incomplete: overview exposure differs by
  2.8419e-5, failing the original 1e-6 comparison. Natural animation also runs.
  Keep that failed audit; do not widen the tolerance or claim a locked image pair.
- [x] Root reviewed all four images: no new visual-quality claim. Dock shadow
  plaid, continuous bare bank rim, sparse planting, uniform lawn and pavilion
  arrival still need art work. Reuse this functional baseline for the next pass.
- [x] Runtime52/database removed, owned browser closed, 996 build-source pins,
  145 protected outputs, retained lock and human localhost:3333/DB unchanged.
- [ ] NEXT: qualify compact-sun bias across dock/pavilion/terrain/foliage and
  three sunlight phases with converged lighting; then larger unequal shoreline
  plant/rock masses and pavilion arrival, protecting fishing and dry routes.
  Continue sustained movement/LOD/cache and admission/frame/heap tail checks
  alongside art. No quality cuts, raised limits, default promotion or deployment.

Evidence: service-layout-network01 `height-sample-*`; inland pond
`build39`, `native73`, `runtime52`. The first fixture attempt selected no
test and is retained as all-skipped; corrected baseline02/03 run the actual case.
Reference checks: [ECMAScript arithmetic](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-numeric-types-number-multiply),
[Three attribute-version contract](https://threejs.org/docs/pages/BufferAttribute.html#version).
The numerical proof and actual tests, not references alone, establish parity.

### Refined face fitting — exact geometry, startup reliability still open

**World first; compact island only; one arena; SOL only.** This is a bounded
CPU-work improvement, not a visual-quality or production-performance milestone.

- [x] Retain native74's original startup failure: two LOD0 cells exhausted the
  unchanged 250 ms fitting cap (262.6 / 250.5 ms elapsed synchronous-slice time).
  No shadow comparison was reached. Add both exact cells to the actual-terrain
  fixture, including startup LOD focus, owner order and dock exclusions.
- [x] Qualify strictly interior refined-face edges conservatively at admission.
  Preserve original endpoint arithmetic, boundary/skinny/multi-owner fallbacks
  and lifetime checks. Charge one extra admission step and 16,129 metadata bytes
  per resolution-128 owner in worker, client and coordinator; no cap increase.
- [x] 601 unique tests pass: 203 surface/same-face, 390 grounding/worker/manager,
  and eight actual pond cases. All 160 independent output-array hashes match.
  Full shared plus explicit changed tests: 726 roots / 2,747 sources, zero
  diagnostics; scoped lint/format pass. Cold reconstruction remains separate:
  three candidate observations exhaust their original cap; no failed prefix
  is compared to completed work or called a passing fit.
- [x] Completed geometric work falls 19–25% in six dense shoreline cases, but
  only 0.38% / 0.31% in the newest two cells. Those small reductions do NOT
  establish that native74's intermittent failure is fixed. CPU timings vary.
- [x] Build40/native75 passes the original startup (38.515 s, all 122 cells)
  and four camera gates (6.006 / 2.648 / 1.772 / 2.645 s). Actual Chrome/Metal
  WebGPU, unchanged camera/render settings, 65/90/71/86 chunks and
  61,453/79,706/66,254/75,996 clumps match native73. Main maximum slice8.6ms;
  admission maximum4.1ms. These are observations, not controlled speedups.
- [ ] Overview exposure differs2.4912e-5 from native73, outside the original
  1e-6 tolerance. No locked-image, frame-rate, sustained movement, cache/heap,
  stream, reliability-tail or AAA acceptance. Root reviewed all four images:
  shadow plaid, bare bank ribbon, sparse planting and pavilion arrival remain.
- [ ] Compact-shadow native76 passes startup40.513s and the overview grass gate,
  but its finite A/B stops at zero bias because the unchanged production render
  profile correctly rejects that experimental setting. Baseline image retained;
  no complete pair or source change. Bias/phase/camera/clock restored; browser
  closed. Correct only the private diagnostic admission, then repeat the
  five-view/three-phase comparison with original grass/convergence limits.
- [ ] Native77 also passes startup37.762s and the overview grass gate, then
  stops at a diagnostic frame-stamp mismatch after the baseline screenshot.
  No zero-bias state is captured. The private check now compares the actual
  main render-list and shadow stamps, with a strictly newer selection-frame
  requirement; global animation ticks can advance without a render. Reviewed
  against installed Three sources, but this diagnostic correction is not yet
  runtime-qualified. All original failures remain retained.
- [x] Delivered60-second native4K island progress cinematic using the actual
  in-game2x preference:1920x1080 CSS /3840x2160 backing,30fps and1,800
  unique rendered frames. Root independently verifies all frame clocks,
  zero grass queues,18 retained PNG hashes, six clips and complete MP4 decode.
  Normal Chrome playback reaches60s with no media/page errors or corruption;
  four startup dropped frames remain recorded, with none afterward.
  Master: progress-videos/hyperia-island-progress-4k-60s-20260921.mp4 (498MB).
  Evidence: progress-videos/island-cinematic-20260921-04/FINAL-AUDIT.json,
  NATIVE-PLAYBACK.json and ROOT-REVIEW.json. All owned capture browsers and
  helpers are closed. This is an offline environment presentation, not live
  gameplay, streaming, startup, AAA or real-time-performance proof. No
  upscaling, interpolated frames, world edits or quality reductions.
  Earlier real-time/startup failures remain retained; production goal is open.
- [ ] Native2x dock review exposes a sharp diagonal water-tone boundary toward
  the far-right bank, visible in both the ordinary pre-capture frame and the
  offline sequence. Investigate it alongside the existing dock-shadow plaid;
  do not attribute it to offline capture or mark the water art approved.
  Evidence: progress-videos/island-cinematic-20260921-04/shot02/.
- [ ] NEXT: complete shadow qualification, then unequal shoreline plant/rock
  masses and pavilion arrival while preserving all fishing and dry routes.
  If exact-cell fitting failures recur, profile the whole-clump swept-envelope
  loop in the actual worker before another optimization. No density/resolution
  cuts, raised limits, default promotion, merge, deployment or installation.

Evidence: service-layout-network01 `refined-edge-*`, `compact-shadow-native74/76`;
inland pond `build40`, `native74–76`, isolated `runtime53/54`. Failed baseline01
fixture/setup and original native failures are retained. Protected playable
localhost:3333, canonical outputs, lock and unrelated changes remain untouched.
Runtime53/54 and their disposable databases are cleaned; the human playable
session remains untouched. Continue water/shadow and world-art work; goal active.

### Compact single-map shadow correction — 2026-09-21

- [x] Correct compact-sun receiver bias without raising render cost: admitted
  compact terrain uses bias 0 with the existing 0.01 normal bias, 4096 shadow
  map and fixed frustum. Legacy single-map, CSM and shadowless paths retain
  their previous settings. No geometry, density, texture, resolution or
  shadow-map budget is changed.
- [x] Carry canonical terrain provenance from the exact scene-owned light to
  capture validation. Compact grass must match it; malformed, noncanonical,
  missing/mismatched provenance and incorrect actual bias fail closed.
  The identity is cached, not serialized/validated anew every readiness poll.
- [x] Verify source with 567 focused tests (453 shared/environment, 13 client,
  101 server policy), scoped lint/format and no-emit shared/server typing:
  717 roots, 2,393 source files, zero diagnostics. The broader mixed client
  program is NOT clean: baseline/current both have 286 diagnostics across
  720 roots/6,790 sources, with zero added or removed diagnostic instances.
  That delta is not a clean whole-project typecheck.
- [x] Inspect real Chrome/Metal A/B evidence at phases .30/.49/.70.
  Native79/build40 completed 24 images over overview, landing, jetty and bank
  arrival before its natural-tree ownership helper failed. Native80/build41
  completed 12 fresh-source images over natural trees and landing before its
  separate water-depth probe failed. Both overall FAILED receipts remain
  retained; completed pairs are not relabeled as complete run passes.
- [x] Visual comparison finds substantially less dock/roof diagonal acne,
  with rail shadows, roof courses, broad tree shadows and contact retained at
  the reviewed views. Close-up GLB trunk/leaf ownership is proved in native80.
  These held views do not certify every canopy, camera, time or target GPU.
- [ ] Resolve the separate pond diagonal color/depth seam and dark bank ring.
  Both persist with corrected shadow bias; no water improvement is claimed.
- [ ] Finish shoreline plant/rock massing, pavilion arrival and cohesive island
  composition, then qualify sustained movement, frame/heap tails, real stream
  capture and target-hardware performance. No AAA or FPS acceptance is granted.

Native78's near-zenith convergence failure is also retained. The private
diagnostic now waits for the same exact light to converge more precisely; it
does not snap matrices, alter the production clock or raise original startup
or camera budgets. Native79/80 restore their original camera, clock and bias,
and close their owned browsers. Build41 is isolated; the new client collector
must be paired with the new shared bundle, not older compiled outputs.
Human localhost:3333, database and canonical compiled artifacts are protected.
World work remains compact-island-only, one arena and SOL-only.

Evidence: `inland-pond-integration01-UNQUALIFIED/native78–80/` and
`isolated-build41-report.json`; verification receipts in
`service-layout-network01-UNQUALIFIED/compact-shadow-*`.
The source checkpoint covers shadows/provenance only, not water acceptance.

Native81/build41 completes the original startup (41.298 s) and landing cut
(2.197 s), with no recorded errors, stable input pins and restored controls/
closed browser. It independently reads both actual pond depth bindings:
24 pixels × four samples, 768-byte result. The two GPU textures are distinct,
but all 96 paired depth values agree exactly. Several samples across the
visible seam change abruptly, so the next check is submitted opaque terrain/
object geometry; the probe alone does not identify the responsible primitive.
No water shader or material setting was changed on this evidence.
Runtime55/56 and their disposable databases are removed. All owned native
browsers are closed; the protected human playable database is unchanged.

### Regional meadow and grass census — 2026-09-22

- [x] Repair the historical grass-shortcut census without changing geometry,
  placement or fitting budgets. The total now reports its refined-face subset;
  canonical-only comparisons and historical savings use the frozen census.
  Exact attribution is 18,063 = 16,954 + 1,109 and 18,436 = 17,306 + 1,130.
  Generation passes 44 tests; grounding/same-face/actual worker/client passes
  316. No semantic golden or frozen reference was changed. Strict worker
  admission validates the new counter; typed helpers explicitly accept the
  historical result rather than inventing its missing diagnostic.
- [x] Implement an independent `grassPalette=regional-v1` fine-meadow trial.
  Reuse the existing fresh and dry-shoulder reflectance endpoints at full
  strength, including distinct green values, through the same CPU/TSL tint
  owner. The original palette/default remains exact. The new grade is captured
  once, carried in worker identity, and rejects invalid contexts or mismatched
  results. Noise frequency, terrain/layer eligibility, roots, RNG, dimensions,
  density, normals, wind, navigation, textures and draw policy are unchanged.
- [x] Verify 451 resolver tests, 230 material/macro/grass-appearance tests, and
  32 placement-worker tests. Together with the 360 census cases above, these
  five receipts contain 1,073 passing tests. Additional helper verification
  passes 89 worker/client cases, nine selected-v9 pond cases and one historical
  review52 case; other fixture-specific skips are not passes. The final focused
  seven-case repeat and 733-root/2,412-source-file no-emit check pass, with
  zero diagnostics and stable pins. Scoped 16-file lint/format/diff checks pass.
- [x] Prove non-color instance bytes remain exact and emitted regional RGB
  matches per-root CPU samples in admitted coastal regions. Historical Haven
  without coastal tint remains byte-exact in all five arrays. Fresh minified
  keepNames workers exercise the regional grade and service descriptor.
  CPU/TSL literal endpoint parity and a nonempty actual texture-graph comparison
  add no texture samples; this is not measured native GPU cost.
- [x] Build nine isolated bundles from 997 inputs in build47, retaining all 145
  protected compiled artifacts. Recheck every build input after the attempt.
  Initial core01 failed because its fixture deliberately disables meadow tint;
  the corrected test now proves that invariant instead of demanding a color
  change there. Initial types01 found unknown-value narrowing and a historical
  helper type mismatch; both failures are retained, not counted as passes.
- [ ] Complete native palette appearance and cost comparison. Native95 used the
  ORIGINAL palette and failed before any qualifying view; native96 was not
  started. macOS logged an eight-second Dark Wake Thermal Emergency sleep,
  followed later by 988 seconds of Maintenance Sleep. Do not describe all
  elapsed time as thermal sleep. Two grounding jobs failed the unchanged
  250 ms limit: LOD0 cell (11,16), 251.6 ms / 214,029 operations; LOD1 cell
  (15,18), 250.9 ms / 101,642 operations. Readiness stopped at 120/122.
  The active_cpu reason counts accumulated slice elapsed time, not thread
  CPU utilization. Untimestamped failure events cannot establish either
  failure's order relative to sleep; neither failure was error-deferred.
- [x] Close the owned browser and stop runtime65; remove its ephemeral database
  and verify protected state unchanged. Localhost3333 remains available.
  No GPU retry, safety-setting change, default promotion, native appearance,
  sustained frame-rate, streaming, 2× cinematic or AAA approval is claimed.
- [x] Identify both failed cells and their executed-build timing semantics.
  The terminal one-operation slice is coordinator settlement, not proof of a
  worker failing on one expensive operation. Cause remains unestablished.
- [x] Reconstruct both reported native95 cells with production mixed-detail
  policy, actual v9 placement and retained terrain, without changing caps.
  The native receipt lacks arrays/packet hashes: this is current-source CPU
  reconstruction, not byte-exact historical input or native timing recovery.
  Selected replay02 retains 959/959 and 1,269/1,269 clumps; cached fits take
  approximately 107/73 ms and full handoff/publication 111/88 ms in that single
  observation. These are not performance distributions or browser measurements.
- [x] Carry the actual pond-service wear through replay requests and detached
  worker settings. The broader run exposed a frozen-oracle mismatch: the old
  reference has no service-wear deformation. Keep every current full-cell
  worker/pipeline check, and compare all frozen numerical outputs to a separate
  full-cell no-service-wear control under the original caps. The southwest
  case changes 11 source-aligned masks with zero clump additions/removals.
  Independent analytic deformation/wind/road tests remain necessary; agreement
  between worker and pipeline alone is not independent shape validation.
- [x] Serialize failure diagnostics as bounded JSON rather than console object
  previews; capture detached cell bounds, browser observation clocks and the
  cumulative fitting-slice maximum. Keep the existing main-thread-only maximum
  unchanged. Input-error messages are bounded and do not invoke getters.
  Private capture code adds Node receipt clocks and explicit text-truncation
  metadata; syntax checked, not executed in a new native browser attempt.
- [x] Pass 396 core/worker/handoff/manager tests and 29 coordinator tests;
  final core/coordinator repeat passes 152 after diagnostic hardening.
  Current v9 passes 11 applicable cases, v10 two, historical review52 one;
  fixture-layout skips remain skips. Final no-emit covers 734 roots and
  2,413 source files with zero diagnostics/stable pins. Seven-file lint,
  format and diff checks pass. Retain the first regular-grid fixture failure,
  frozen-oracle mismatch and readonly-tuple type diagnostic with their fixes.
- [x] Profile one reconstructed native95 western cached fit in its actual
  minified browser bundle / Node worker isolate. The opt-in inspector attaches
  only to that isolate, closes before termination, and preserves original
  result transfers and 250 ms / one-million-operation limits. Retain the raw
  81-sample profile, source map and hashes: eight samples are GC; this is a
  lead for allocation reduction, not exclusive CPU attribution or native cause.
- [x] Reuse job-local base/envelope bounds, filtered surface entries and the
  road-deduplication Set. Scratch never aliases retained owners or escapes into
  output; complete generators reset it before reuse. Every numerical expression,
  suspension, work charge and geometry/population input remains unchanged.
  Set.clear may still allocate internal storage; allocation-free is not claimed.
- [x] Compare the exact archived baseline with the candidate in four serial
  AB/BA pairs of fresh workers, each admitting independent transferred copies.
  All eight retain the same 959 clumps and exact attributes, roots, masks,
  source indices, bounds, dependencies, non-timing receipts and input/result
  bytes, with 280,384 operations. Twenty-four other bundle dependencies
  are hash-identical.
  Baseline active times are 105.829–114.658 ms, median 110.834; candidate
  108.165–110.722 ms, median 110.047. Two pairs improve and two regress;
  maximum slices reach 3.156 versus 3.785 ms. No meaningful timing gain,
  lower GC cost, native loading fix or frame-rate improvement is established.
- [x] Pass 427 core/actual-worker/coordinator/manager checks, including two
  new repeated-road, mixed-owner and interleaved-scratch regressions against
  frozen numerical results. The first run retained 424 passes and three
  diagnostic-helper failures: move only the unique extraction end marker to
  the reset statement, preserving the exact transform/helper source and tests.
  Full no-emit passes 734 roots / 2,413 source files with stable hashes.
  Selected v9/v10/historical pond runs pass 11/2/1 applicable cases: 441
  applicable core and pond checks in total, excluding repeats and layout skips.
- [x] Resume bounded native terrain-only comparison on the now awake/open-lid,
  AC-powered host with nominal OS thermal state. Build48 contains nine fresh
  bundles from 997 pinned inputs, preserving all 145 compiled artifacts.
  Native97/v9 and native98/v10 each pass the unchanged 90-second startup and
  four 30-second camera/grass gates on actual Chrome/Metal WebGPU. Both keep
  the original palette, 1280×720 backing, density, lighting and draw policy;
  only the southern bank manifest differs. All eight qualifying PNGs and
  per-view receipts are retained; both captures finish without reported errors.
- [x] Retain the gentler v10 bank as the next private art baseline. In the
  matched landing view it removes the conspicuous sharp diagonal water-depth
  wedge. The overview also becomes rounder and loses some headland character:
  this is a local shoreline gain, not final pond-shape or whole-island approval.
  Opposite-dock and pavilion views show no obvious static contact regression.
  Wind, particles and moving actors are not phase-locked; dynamic edge quality,
  complete traversal/fishing and sustained performance remain unqualified.
- [x] Add a bounded private capture host guard: sample OS thermal/AC/lid/display
  state every five seconds; close only the owned browser on an observed unsafe
  state, sampling error or excessive interruption. Both runs retain nominal
  samples and close normally. This is not continuous temperature monitoring,
  physical ventilation confirmation or proof that every brief sleep/thermal
  excursion would be detected. No sleep/power/thermal setting was changed.
  Runtime67/68 stop cleanly, remove their own ephemeral databases and verify
  the original localhost3333 services/database unchanged.
- [ ] Native95 remains failed and its cause remains unestablished. Later
  successful captures do not erase that failure or prove the scratch reuse
  fixed it. Complete the independent regional-palette comparison, optical
  water contrast/moving-edge checks and actual performance distributions.
  Camera-axis depth is not physical water-path thickness; submitted sample-0
  MSAA depth may accentuate real silhouettes, not proof of another root cause.
  The previous manual host-confirmation hold is superseded by fresh live
  readiness and bounded automatic stopping, not by an assumed user reply.
  Continue broader landform structure, vegetation grouping, natural routes,
  pavilion/dock finish and shoreline composition. Flat timber and large uniform
  grass areas remain visibly below the target; no AAA, stream or 2× cinematic
  acceptance is claimed. The protected playable scene is not silently replaced.

- [x] Test and reject the compact deck-joint normal experiment. Native99/build49
  passes all four original v10 views, but two reviewers find no worthwhile
  improvement at the intended camera distance. Restore both source/test files
  exactly to HEAD; retain the rejected patch, immutable build, PNGs and verdict.
  The trial passed 22 dock tests, full 734-root/2,413-file no-emit, lint and
  format checks. Its first run retained one test-helper identity failure.
  No moving-surface or GPU-cost acceptance was obtained or implied.
  Runtime69/browser and its ephemeral database are closed/removed; protected
  human state remains unchanged. Technical success did not justify keeping it.
- [x] Preserve the exact retained v10 world-area snapshot under versioned
  `docs/world-art-candidates/pond-southern-bank-v10.world-areas.json`, with
  its baseline hash, two-byte radius change and non-runtime scope documented.
  It contains earlier private layout work, not a one-field production patch.
- [x] Implement and retain the compact-pond optical trial as the next private
  art baseline. Convert the existing camera-axis depth gap to bounded
  unrefracted viewing-ray length, use exponential neutral attenuation (3 m
  half-transmittance), and use a muted constant deep tint. Perspective and
  orthographic camera expressions are tested from the actual TSL graph.
  Ordinary lake/ocean expressions, geometry, waves, flow, lighting, Fresnel,
  reflection policy and fog stay unchanged; no new texture sample or pass.
  This is not spectral absorption, Snell refraction or full volume scattering.
- [x] Verify 17 material cases on v10, then 70 cases across five files on the
  canonical manifest; full 734-root/2,413-file no-emit has zero diagnostics.
  Scoped lint/format/diff checks pass. Retain initial types01's six narrowing
  errors and their fixes. Core02 on v10 has 69 passes and one fixture failure:
  the old test shrinks the 27 m pond to 12 m without shrinking its wet terrain.
  The coverage gate correctly rejects that fabricated basin. Do not weaken
  it, call core02 green, or infer full v10 integration from canonical tests.
- [x] Build50 retains all 145 protected outputs and differs from build48 in
  only the production WaterSystem input. Native101 passes the unchanged
  startup and four camera/grass gates on v10. Two still-image reviews find a
  clearer shallow/deep transition and less flat cyan water, without an obvious
  new dock-contact or shoreline-seam regression. The overhead pond is darker
  and less inviting; uniform muddy perimeter, sparse planting, bright lawn
  and plain timber still fall short. Human localhost defaults are unchanged.
- [x] Record a separate six-second, 1280x720 canvas yaw clip after a 12-second
  held-camera timing window. The clip decodes to 133 frames, with uneven
  timestamps; six sampled frames show no obvious abrupt optical discontinuity.
  This is diagnostic evidence, not smooth-motion approval, a 60-second clip,
  2x game resolution, streaming proof or the requested cinematic deliverable.
  Timing hooks restore, owned query resources are destroyed, video tracks stop
  and the camera is restored; the owned browser closes.
- [ ] Complete matched performance and startup-reliability qualification.
  Fresh baseline native100/build48 fails before any qualifying view, before
  timing/recording hooks: cell (13,17), LOD0, 251.900 ms/33,741 resumptions,
  cumulative fitting maximum 84 ms. All 21 sampled host states were nominal;
  cause is not established. Do not blame heat, GC or preemption without proof,
  retry until green, or raise caps. The missing bounded diagnostic is the
  worker-versus-transport fitting-settlement accounting, not another profiler.
  Candidate native101 has 12 native GPU-envelope samples, 46.53-59.05 ms,
  and held RAF intervals p50 27.6/p95 37.3 ms. Pass timestamps overlap:
  do not sum them or interpret them as exclusive shader costs or presented FPS.
  This is not evidence of smooth performance or of the water change's cost
  relative to baseline, since no fresh qualifying control was obtained.
- [x] Stop runtime70/71 and remove only their ephemeral databases; verify human
  services, database, lock and all 145 protected artifacts unchanged. Preserve
  both failed baseline and successful candidate. The known unmodeled-cow 404
  remains an explicitly deferred placeholder issue, not a newly hidden error.
- [ ] Next visible art work: combine the retained v10 bank with only the
  previously authored v11 three-tree eastern-backdrop regrouping, then recheck
  routes, dock/fishing clearances, resource ownership and visible draw budgets.
  Do not switch wholesale to v11's older bank geometry or add redundant trees.
  Continue regional meadow variation, broader natural landforms/routes and
  readable dock/pavilion silhouettes. Avoid imperceptible micro-detail trials
  while the wide scene remains uniformly grassy and sparsely composed.

Evidence: service-layout `refined-census-*`, `regional-meadow-material01`,
`regional-meadow-placement-full01`, `regional-meadow-resolver-final01`,
`regional-meadow-final02`, `regional-meadow-types02`; inland-pond
`isolated-build47-report.json`, `native95/process.json`,
`native95-host-suspension.md`, and `runtime65/process.json`.
Follow-up service-layout receipts: `native95-grounding-replay02`,
`native95-oracle-native72-01`, `native95-grounding-v9-full02`,
`grounding-diagnostics-core01`, `fitting-slice-coordinator-full01`,
`grounding-diagnostics-final02`, `grounding-diagnostics-v10-01`,
`grounding-diagnostics-review52-01`, and `grounding-diagnostics-types02`.
Allocation follow-up: `native95-western-cached-profile01`,
`native95-western-cached-cpu01*`, `grounding-scratch-ab01`,
`grounding-scratch-core02`, `grounding-scratch-v9-01`,
`grounding-scratch-v10-01`, `grounding-scratch-review52-01`,
`grounding-scratch-types01`. The opt-in worker profiler follows the official
[Node inspector CPU profiling API](https://nodejs.org/docs/latest-v22.x/api/inspector.html#cpu-profiler);
no network inspector or main-thread attachment is used.
The official [Three forest generator](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/generators/ForestGenerator.js)
and [terrain generator](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/generators/TerrainGenerator.js)
inform coherent regional color groups and placement-independent variation,
not copied demo populations, replacement resource trees or new noise samples.

Native terrain follow-up: inland-pond `isolated-build48-report.json`,
`headland-build48-preflight04.json`, `native97/process.json`,
`native98/process.json`, `runtime67/process.json`, `runtime68/process.json`.

Rejected dock experiment: service-layout `dock-joint-relief-core01/02`,
`dock-joint-relief-types01`; inland-pond `isolated-build49-report.json`,
`dock-joint-relief-build49-preflight01.json`, `native99/ART_VERDICT.md`,
`native99/rejected-dock-joint-relief.patch`, `native99/process.json` and
`runtime69/process.json`. The implemented neutral-extinction trial follows the primary
[PBRT homogeneous transmittance reference](https://pbr-book.org/4ed/Volume_Scattering/Transmittance)
and [Three r186 view-depth implementation](https://github.com/mrdoob/three.js/blob/r186/src/nodes/display/ViewportDepthNode.js);
these references do not establish actual appearance or performance.


Water follow-up: service-layout `pond-ray-extinction-core01/02/03` and
`pond-ray-extinction-types01/02`; inland-pond `isolated-build50-report.json`,
`pond-ray-extinction-preflight01.json`, `native100/process.json`,
`native101/process.json`, `native101/ART_VERDICT.md`,
`native101/landing-held-native-timing.json`,
`native101/landing-optical-motion.webm`, `runtime70/process.json` and
`runtime71/process.json`. The six-second clip and stills are diagnostic only.

### Living vegetation follow-up — 2026-09-22

User direction: make wind-connected trees, flowers in the grass, moving flower
stems/petals and occasional falling leaves part of the compact island art pass.
These are open launch tasks, not delivered visual features.

- [x] Trace the actual resource-tree path: manifest variants use
  GLBTreeBatchedInstancer; single models use GLBTreeInstancer. Both use
  GPUMaterials.createTreeDissolveMaterial. Its current leaf mask explicitly
  suppresses bark wind; r186 applies instance transforms before positionNode,
  so the current absolute-Y amplitude also includes terrain elevation.
- [ ] Implement connected, root-anchored wood/leaf motion from shared per-tree
  wind, stable across species, position, yaw, uniform scale, LOD, shadows,
  depletion/respawn and streaming. Keep roots stationary, the trunk restrained
  and finer foliage motion subordinate; correct deformed normals and bound
  animated culling extents. Verify real WebGPU motion and measured added cost,
  not just stills or CPU shader graphs.
- [ ] Add restrained, irregular flower patches using the current terrain-owned
  grass/surface lifecycle, actual retained ground, local water and exclusions.
  Keep paths, station working space, resource access and combat readable.
  Roots must stay fixed while stems bend and petals respond more delicately.
- [ ] Add occasional, species-appropriate falling leaves from live nearby
  canopies, with wind drift, tumble and bounded lifetime. Use one pooled visual
  owner, not a particle draw call/physics object per tree or persistent litter.
  Depletion, unload, teardown, respawn and late loads must not leak or duplicate
  emitters. Test pause/resume, large delta, teleports and repeated streaming.
- [ ] Establish and measure flower/leaf/emitter/work/allocation/upload caps,
  animated culling and LOD/fade behavior, depth/fog/lighting and overdraw.
  Compare matched cold/warm and moving WebGPU views, frame-time tails and
  memory; do not silently reduce quality/resolution to meet performance.
- [x] Inspect existing flower code before reuse. ProceduralFlowerSystem is
  disabled for a spawn investigation and depends on the disabled older grass
  heightmap, with a five-second wait and camera/player-Y fallback. Do not
  simply re-enable it. Existing flower billboards are reference code, not
  qualified rooted stems/petals; no current falling-leaf pool was found.

Primary references: [GPU tree wind hierarchy](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-6-gpu-generated-procedural-wind-animations-trees)
and [separate main/detail vegetation bending](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis).
These motivate shared, bounded GPU deformation; they do not prove this
implementation, art direction or performance acceptable.

### Fitting diagnostics and combined-layout qualification — 2026-09-22

- [x] Add a failure-only, frozen scalar worker fitting receipt. It retains the
  submitted work, actual response, transport/pre-merge and merged work without
  snapshots/buffers, successful-result allocation, retries or budget changes.
  It explicitly ends before the enclosing main supervision tail. Actual worker
  failure, exact merge arithmetic, absence on success/cancel/admission failure,
  historical retention and teardown are covered.
- [x] Canonical worker/client/coordinator/generation suites pass 163/163.
  The selected v10 run retained 144 passes and 19 historical generation-fixture
  failures; these are not suppressed. Their old road-count, station-margin,
  pond-profile/partition and failed-fixture-cleanup assumptions are documented
  in fitting-settlement-core02-qualification.md. Canonical core03 briefly
  overlapped type checking: functional proof only, not a CPU performance result.
- [x] Prepare v12 as the retained v10 bank plus the previous v11 three-tree
  regrouping. All other fields and 39 asset links stay unchanged; 41 manifest
  pins hold. The selected actual-geometry/lifecycle test passes, including
  48 completed resource-to-bank routes and source-canopy road/dock/pond margins.
  Five selected dock/terrain tests and the historical v11 selected test pass.
  Skipped unselected fixtures are not passes. Static LOD0 margins do not prove
  animated canopy clearance, all LODs or fishing gameplay.
- [x] Full relevant strict type check: 734 roots / 2413 files, zero diagnostics,
  stable source pins; three changed TypeScript files pass lint/format checks.
  Isolated build51 produces nine bundles, preserves 145 protected artifacts
  and changes only fitting diagnostics in its 997 production inputs.
- [x] Native102/v10 and fresh native104/v10 pass the five original camera/grass
  gates. Native103/v12 stops before browser creation because the old guard
  incorrectly required recent HID input despite an awake display. Correct the
  private guard to actual CoreGraphics active/awake state plus powerd,
  retaining AC/lid/thermal/gap/duration checks: 43 parser/policy tests and one
  actual read pass. No synthetic input, wake API or power-setting changes.
- [ ] Resolve intermittent startup fitting-budget failure. Fresh native105/v12
  fails the original 90-second startup gate with zero views. Its new receipt
  establishes a raw worker failure: 139739 operations / 250.500 ms against
  the unchanged 250 ms limit, maximum elapsed slice 54.300 ms; merged work
  251.200 ms and final supervision total 252.100 ms. All 20 sampled host states
  are nominal/AC/awake. Elapsed spans are not exclusive CPU, and this does not
  identify the underlying scheduler/GC/geometric cost or blame tree placement.
- [ ] Visually qualify combined v12; no candidate comparison images exist.
  Preserve native103/105 failures; do not claim v12 art acceptance, promote
  defaults, raise fitting caps or retry until green. Native104's five reviewed
  baseline stills retain the dark overhead pond, uniform mud/lawn, plain timber
  and sparse layering as open art issues. The 60-second actual 2x cinematic
  remains outstanding; six-second diagnostic yaw clips are not that delivery.
- [x] Postflight verifies all 997 build inputs, nine outputs and 145 protected
  artifacts unchanged. Runtime72–75 are stopped, their owned temporary DBs
  removed, and capture browsers closed. Human localhost3333 stays HTTP200
  with its original processes, database, character and compiled artifacts.

Evidence: service-layout fitting-settlement-core01/02/03,
woodland-v12-core01/02, woodland-v11-regression01, woodland-v12-docks01 and
woodland-combined-types01; inland-pond candidate-manifest-assets-v12-report.json,
isolated-build51-report.json, woodland-build51-preflight01/02.json,
woodland-build51-postflight01.json, host-readiness-guard-display01-receipt.json,
native102–105/process.json, native104/ART_VERDICT.md and
native105/FAILURE_QUALIFICATION.md. Helpers/receipts stay private; v12 is not a
new runtime manifest.

Three.js source references for the next living-vegetation slice:
[ForestGenerator r186](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/generators/ForestGenerator.js)
for seeded patches/clearings, instancing and near-only detail;
[instance uniforms](https://threejs.org/examples/webgpu_instance_uniform.html)
for variation within shared rendering;
[GPU snow source](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_compute_particles_snow.html)
for a shared GPU particle pool; and
[soft particles](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_particles_soft.html)
for depth-intersection treatment. Reuse principles selectively: not the snow
demo's 100k population, persistent deposition, frame-dependent fall step or
extra collision render pass. Flowers/leaves still need terrain/resource
lifetime integration and real-game costing. The
[procedural terrain example](https://threejs.org/examples/webgpu_tsl_procedural_terrain.html)
remains an art/TSL reference, not replacement authority for gameplay terrain.

#### Connected tree-wind foundation — NOT active in the game

- The actual resource GLB shader masks the whole sway by leaf color, leaving
  bark stationary, and uses post-instance absolute Y. A standalone replacement
  now derives shared full-LOD0 height metadata, anchors roots, and bends matching
  wood/leaf coordinates together. Main displacement is capped at 0.36 m; finer
  leaf flutter is not implemented yet.
- It reuses native r186 batch matrix textures/storage matrices and preserves
  borrowed geometry/collision ownership. Pool world identity and upright
  yaw/positive uniform scale are explicit admission requirements. Ordinary
  uniform-buffer instancing is deliberately unsupported.
- Independent source review caught an authored-tangent coordinate defect that
  the initial vertical-tangent cases missed. Corrected tests include zero-wind
  and oblique normal/tangent pairs under yaw and scale; authored tangents are
  forward-transformed before applying the bend Jacobian. Initial root01/types01
  receipts remain historical, not final acceptance.
- Final focused tests: 32/32; full shared plus explicit retained-world
  no-emit: 736 roots, 2,415 sources, zero diagnostics, unchanged source pins.
  Scoped lint/format and review pass. Actual r186 storage WGSL flow generation
  uses an uninitialized real renderer, not a rendered/GPU acceptance test.
- Read-only GLB header census of retained general01/03/05 found bark normal
  textures but no authored tangent attributes. This is not all-model/all-LOD
  coverage or a substitute for inspecting loader-baked geometry.
- [ ] Integrate explicit material mode and owned metadata into both resource
  pools; preserve per-variant descriptors across missing LODs and slot matching.
- [ ] Qualify animated bounds, exact tree/resource lifetime, shadows and actual
  headful WebGPU material/LOD variants. Compare naturally moving close-ups and
  matched frame/memory cost before activation or visual approval.
- [ ] Keep native105's grass-fitting failure open. Do not raise its work caps,
  relabel elapsed timing as exclusive CPU, or equate later success with a fix.

Private receipts: tree-wind-foundation-root02.json and
tree-wind-foundation-types02.log/process.json in the retained service-layout
evidence directory; tree-wind-retained-model-headers01.json; and
inland-pond-integration01-UNQUALIFIED/TREE_WIND_NEXT.md.
No runtime import, public asset/default promotion, or live localhost change
is part of this foundation checkpoint.

#### Connected tree-wind integration — opt-in; native approval still OPEN

- [x] Connected `TreeWind` to the real resource-tree materials and BOTH loader
  paths behind explicit `treeWind=connected-v1`; omission retains legacy leaf
  sway. The option is captured once per client world and passed to both pools.
  Unknown/duplicate selectors fail closed. No public default is promoted.
- [x] Derive one immutable full-LOD0 descriptor per actual baked variant, share
  it across wood/leaves and all LODs, preserve original variant indices through
  missing LODs/material-slot reordering, and retain borrowed collision geometry.
  The batched path now uses per-variant all-LOD bounds plus the bounded bend;
  static interaction bounds are not advertised as animated collisions.
- [x] Own/dispose added geometry, materials and partially created pools; guard
  live/pending world or mode replacement; validate candidate transforms before
  removing an old instance; preserve that instance when a destination is full.
  Real HTTP GLB/ClientLoader/ModelCache integration tests cover both pools,
  missing LODs, deplete/respawn, stale loads and failed replacement.
- Verification: integration-regression02 passes **540/540** across six files;
  integration-types02 covers **739 roots / 2,418 sources / zero diagnostics**
  with stable source pins. Scoped nine-file ESLint/Prettier and diff checks pass.
  Initial three type diagnostics were corrected before these final receipts.
- Private **build52** completes nine bundles with 998 pinned inputs and all
  145 protected artifacts unchanged. Against build51, exactly five production
  inputs changed and TreeWind was added. Preflight includes 43 host-guard tests,
  real AC/awake display/nominal thermal state, source and helper hashes.
- Actual headful Chrome/Metal control **native106/runtime76/build52/assets-v10**
  fails the unchanged 90-second startup gate before any of the five review
  views. It uses LEGACY wind, not the connected candidate. At the deadline,
  121/122 grass cells are ready and one failed; terrain and water are ready.
  The raw worker fitting receipt for generation20/job23 already exceeds the
  250 ms limit: 250.9 ms / 146,048 operations / maximum slice 89.3 ms. The
  main merge is 251.1 ms and the final supervision tail brings it to 251.4 ms.
  Therefore this is not merely an over-budget main-thread tail. These elapsed
  slices include scheduling/GC; exclusive CPU or the cause is not established.
  All 21 host samples were nominal/AC/awake, with no host-guard error.
- No control close-up, held wind video or native connected-wind shader proof
  was obtained. **native107/runtime77 were not launched** after the failed
  control. Retain the failure screenshot/receipt; do not retry to manufacture
  a green comparison, increase work caps, or claim tree-wind visual/perf success.
- [ ] Diagnose the long worker fitting slice and retain exact phase/work evidence;
  resolve grass readiness before a fresh matched native comparison.
- [ ] Visually verify coherent wood/canopy motion, anchored roots, normals,
  shadows, culling/LOD transitions and actual frame/memory cost in both pools.
  Fine leaf flutter, habitat flowers and bounded falling leaves remain open.
- Owned control browser is closed; runtime76 is STOPPED, its temporary test
  database was removed, and protected localhost:3333 services/data/bundles are
  unchanged. No change to graphics quality/resolution or the human game.

Evidence: retained service-layout `tree-wind-integration-regression02.*`,
`tree-wind-integration-types02.*`, `tree-wind-build52*` and
`tree-wind-native106*`; inland-pond `isolated-build52-report.json`,
`tree-wind-build52-preflight01.json`, `native106/process.json`,
`native106/failure.png` and `runtime76/process.json`.
Official Three.js references above remain implementation references, not
automatic proof of AAA art quality, a completed cinematic or launch readiness.

#### Grass fitting cost and local timing — checkpoint; readiness still OPEN

- [x] Prove disjoint terrain-owner bounds once per fitting job, then omit
  redundant per-clump owner-pair checks. Touching edges are safe; any positive
  overlap preserves the original overlap/dependency path. Exact-output oracle,
  gaps, tiny overlaps, cancellation and interleaved-job tests retain the
  original geometry and work caps. This is a small work reduction, not a
  measured game-speed or loading-success claim.
- [x] Add bounded worker-local peak-slice and peak-clock-interval observations
  using existing clock reads, two reusable scalar records and meaningful
  grounding phase labels. Failure-only wire snapshots are detached/validated,
  bounded by the cumulative maximum and local added work with derived
  floating-point tolerance. No extra clocks, unbounded histories, excluded
  stalls, reset budgets or increased limits.
- Final validation is **NOT all green**: regression03 passed 609/609 before the
  final client-only diagnostic validation tightening; regression04 passes
  **608/609**, with the existing synchronous pond-support publication case
  failing at 250.116 ms / 138,240 resumptions. Earlier regression01/02 failures
  were exact phase/work-count expectations corrected without relaxing output
  checks. Full types01 passes 739 roots / 2,418 sources / zero diagnostics
  with stable pins; scoped eleven-file ESLint and format/diff checks pass.
- The new actual-v10 native106-cell reconstruction is retained and explicitly
  asset-gated. Reconstruction01 overlapped the tail of regression03 and failed
  cached fitting; its timing is not uncontended evidence. Serialized
  reconstruction02 completes cached fitting at 128.500 ms and full production
  handoff/publication at 131.593 ms under unchanged limits, but its separate
  no-service-wear numerical control fails at 250.122 ms / 141,824 operations.
  Thus the test still FAILS; do not summarize the partial success as a pass.
  This is actual current terrain/worker reconstruction, not a byte-exact replay
  of native106's unretained packet or browser-performance qualification.
- Private build53 completes nine bundles / 998 inputs with exactly five changed
  production inputs against build52, no added production input, and 145
  protected artifacts unchanged. The diagnostic preflight explicitly records
  the known test failures; it is NOT a successful qualification gate.
- **native108/runtime78/build53/assets-v10** (legacy-wind control) fails the
  unchanged 90-second startup gate with 121/122 grass cells ready. The failed
  cell is now LOD1 gcell_v1_15_17 (x375..400/z425..450), not native106's LOD0
  western meadow. Raw generation56/job60 fitting consumes 250.000001 ms /
  148,346 operations; main merge reaches 251.000002 ms and supervision
  251.300002 ms. Peak local slice: 13.900 ms, operations 47,354..48,634,
  anchor_surface to grounding_operation. Peak observed clock interval:
  12.800 ms, operations 48,570..48,634, interval_merge to grounding_operation.
  These are elapsed spans including possible scheduling/GC, not exclusive CPU
  or proof that either endpoint phase caused the delay. All 19 host samples
  were nominal/AC/awake. No matched views or held tree-wind video were reached.
- [ ] Remove measured inner-loop allocation opportunities while preserving
  exact suspension/work/ownership behavior: this reconstructed cell creates
  39,360 endpoint generators and 19,680 edge generators, with 16,990 edges
  completing through the zero-yield same-face path. Avoiding those short-lived
  objects is a candidate for measurement, not an established timing cause.
- [ ] Resolve both synchronous/worker budget failures and repeat a fresh native
  comparison before accepting connected wind, flowers, falling leaves or the
  requested 2x cinematic. No quality, density, resolution or deadline reduction.
- native109/runtime79 were NOT launched. Native108's owned browser is closed;
  runtime78 is STOPPED, its temporary database removed and protected human
  runtime/bundles/retained lock unchanged. The failure image was inspected:
  broad plain grass fields, hard path/arena forms and pond/art composition
  still need work; this is not AAA visual acceptance.

Evidence: service-layout `grounding-local-slices-regression01..04.*`,
`grounding-local-slices-sameface03.*`, `grounding-local-slices-types01.*`,
`grounding-local-slices-native106-reconstruction01..02.*`;
inland-pond `isolated-build53-report.json`,
`grounding-local-slices-build53-preflight01.json`,
`native108/process.json`, `native108/failure.png`, `runtime78/process.json`.
The official Three.js reference library remains the implementation guide;
these correctness/diagnostic results do not replace visual or performance proof.

#### Grass generator allocation reduction — exact contract retained

- Inline endpoint sampling in the existing continuation and run the certified
  same-face proof synchronously before creating the fallback clipping generator.
  Completed jobs avoid endpointQueries + sameFaceEdges generator invocations
  (56,350 in the reconstructed western meadow). This is a source/count fact,
  not a measured V8 heap-allocation or GC saving.
- All 19 pre-edit f50b8d985 phase/operation/work goldens match; independent
  numerical output goldens remain byte exact. Six borrowed-geometry mutation
  and six actual attribute/region invalidation checks cover endpoint suspension
  boundaries. No work-cap, yield, density, quality or deadline reduction.
- Full regression01 passes 640/640; full types01 covers 739 roots / 2,418
  sources / zero diagnostics with stable pins; scoped ESLint/format pass.
  Independent source and test review found no concrete semantic blocker.
- New native108 reconstruction uses actual v10 owners, LOD1, original focus
  and failed cell bounds. Its f50 before01 passed. After01 retains mixed
  results: native106 full test passes (including its previously failing
  no-service-wear control at153.450ms), native108 cached fit exceeds250ms.
  Thermal1 was observed after the latter run; no reliable speed comparison or
  explanation of that failure is established, and it is not discarded.
- Private build54: nine bundles / 998 inputs; only GrassBladeGrounding.ts
  differs from build53; 145 protected compiled artifacts unchanged.
- Native110/runtime80/build54/v10 (legacy wind) still fails the unchanged
  90-second startup gate: 120/122 grass cells ready, two failed cells
  gcell_v1_13_17 and gcell_v1_12_17 (both LOD0). This is not loading success.
  The last worker failure (generation29/job21) records250.300ms/133,964
  operations; its peak slice88.100ms includes an86.200ms clock interval over
  only64resumptions (grounding_operation to endpoint_owner). Main merge reaches
  251.600ms, supervision251.700ms. The earlier cell's final main receipt is
  251.400ms/162,445operations with cumulative maximum24.600ms. Twenty actual
  host samples were nominal/AC/awake; no matched view or wind video was reached.
- [ ] Capture the actual browser grounding-worker CPU/GC profile around the
  long interval before selecting another optimization. Phase endpoints and
  removed generator calls do not identify GC, exclusive CPU, scheduling or JIT
  cost. Reuse the existing bounded CDP observer; preserve the original startup
  budget and retain instrumentation overhead as an explicit limitation.
  [Chrome's memory guidance](https://developer.chrome.com/docs/devtools/memory-problems)
  and official [Profiler](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/)
  / [Tracing](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/)
  interfaces inform that diagnostic, not an assumed cause.
- Native111/runtime81 were NOT launched after the failed control. Native110's
  browser is closed, runtime80 STOPPED and temporary database removed; protected
  localhost services/data/compiled artifacts remain unchanged. Failure image
  inspected: no new visual approval, grass/whole-world readiness still OPEN.
  Connected tree-wind comparison, flowers/leaves and full cinematic remain OPEN.

Evidence: service-layout `grounding-generator-f50-baseline01.*`,
`grounding-generator-core01.*`, `grounding-generator-sameface01.*`,
`grounding-generator-regression01.*`, `grounding-generator-types01.*`,
`grounding-generator-native108-before01.*`,
`grounding-generator-native-cells-after01.*`; inland-pond
`isolated-build54-report.json`, `grounding-generator-build54-preflight01.json`,
`native110/process.json`, `native110/failure.png`, `runtime80/process.json`.


- Follow-up native112/runtime82 reused build54/v10 with a bounded worker-only
  startup profiler (1ms sampling; one exact worker; no page-main profiling).
  Review added a start-acknowledgement-before-gate-settlement assertion so an
  entirely late profile cannot count as startup evidence. Private helper syntax
  and all43 host-state tests pass;998 source pins and9 bundle pins match.
- Native112 stopped BEFORE browser launch: the first actual host sample was
  thermalState1, despite an earlier nominal preflight. No worker profile,
  readiness run, screenshot or timing comparison was produced. The additional
  missing-framework receipt follows from no navigation, not a game defect.
  Preserve native112/process.json as a host-preflight failure, not a new
  reproduction of native110. Runtime82 is STOPPED; temporary DB removed;
  protected145 artifacts, retained lock and localhost services remain unchanged.
- [x] Resume the startup-worker recording with fresh native113/runtime83 IDs
  after nominal host readings; original guard/budgets retained. See below.
  Other substantial host load was observed; its causal contribution is unknown.


#### Rooted meadow flowers and actual worker profiling — 2026-09-22

- [x] Add an inactive, separately exported rooted meadow-daisy geometry factory.
  It produces one indexed 362-vertex / 584-triangle mesh (28,120 bytes of final
  attributes and indices), with a curved tapered stem, two attached lance
  leaves, pollen head and ten cupped petals. No textures, per-flower objects,
  materials or runtime registration are added by this factory.
- Actual shared stem/head/leaf/petal attachment vertices, exact ground-plane
  roots, authored-height metadata and per-petal hinge/flex metadata are present.
  Thin leaves/petals require the future material's DoubleSide handling. Bounds
  are STATIC ONLY: animated bounds and normal deformation remain unimplemented.
- Geometry01 passes35 topology/metadata/ownership tests across0.12–0.8m plus
  four existing real TSL material-construction tests (39/39 total). Full procgen
  plus explicit new tests typecheck:133 roots/756 sources/zero diagnostics and
  stable source pins. Scoped lint/format and independent source review pass.
  No native flower image, lighting, wind, animation or GPU-cost approval exists.
- [ ] Implement the per-world Wind-driven material and corrected deformed
  normals, with root-fixed stem bending and bounded petal motion. Reuse the
  coordinate-frame lessons from the official r186 forest/NodeMaterial sources;
  do not use the old sprite material's disconnected time/wind controls.
- [ ] Integrate sparse irregular patches at retained terrain publication, with
  separate deterministic selection and bounded shared instances. Revalidate
  terrain/exclusion leases and retire through the existing chunk/LOD lifecycle.
  Add flower-only resource/interaction-approach clearance from actual admitted
  entities; current grass snapshots do not include every live tree/ore anchor.
  Do not alter grass RNG/budgets or re-enable disabled heightmap-based flowers.
- Native113/runtime83 reused immutable build54/v10 (NOT the new flower source).
  The worker-only instrumented run passed the original90-second startup gate
  in44.496s:29/29 terrain and122/122 grass cells, water ready, zero failed grass
  cells. All11 host samples were nominal/AC/awake. Original native110 failure
  remains unresolved; this is not proof that startup is reliable or faster.
- Actual profile is complete: one worker,30,707 samples/168nodes,42.737392s
  sampled interval, proper stop/disable/detach and zero pending commands.
  The actual transformed served script and inline map are retained, not assumed
  identical to the minified build. User's other game remained active at reduced
  settings: diagnostic evidence only, NOT uncontended performance acceptance.
- Weighted sampled intervals:38.295922s idle and161.334ms attributed to92 GC
  samples. groundGrassBladeSteps is the dominant JavaScript function
  (1.724674s self /3.017347s inclusive). These are sampling aggregates, not
  exclusive CPU or GC pauses. A103.793ms delta lands on validateAdmission after
  idle and cannot be assigned wholly to that function.
- Its actual generated-line position ticks identify the swept-bounds setup
  and fade/transform/extrema blocks (source1287–1315):221 of1141 function-line
  ticks. This motivates inspecting repeated scalar/attribute work there, but
  does not locate or explain native110's historical86.2ms interval.
- Owned browser closed; runtime83STOPPED; temporary DB removed. Native input
  pins, protected145 compiled artifacts/lock and playable localhost unchanged.
  Connected tree-wind native comparison, flowers, falling leaves, cinematic,
  sustained frame-time/memory testing and full visual acceptance remain OPEN.

Evidence: service-layout `rooted-flower-geometry01.{json,log}`,
`rooted-flower-types01.{json,log}`; inland-pond `native113/process.json`,
`native113/startup.worker-1.cpuprofile`, `native113/startup.worker-served.js`,
`native113/startup.worker.js.map`, `runtime83/process.json`.


#### Swept-bounds scalar reuse and rooted flower material — 2026-09-22

- [x] Reuse vertex-local grass UV/position reads, wind-envelope products and
  corrected height in the profiled swept-bounds loop. Nothing is cached across
  its blade yield; multiplication/addition order, fades, operation charges,
  density, grounding and published output contracts stay unchanged.
- Full grass regression passes 652/652 cases, including 12 new late-mutation
  and invalidated-job cases. The exact-output/work/phase goldens remain intact.
  Independent review found no blocker. This establishes native owned-data
  numerical parity, not arbitrary accessor side effects or a measured speedup.
  Native110's startup failure remains unresolved; no new runtime was launched.
- [x] Add an INACTIVE rooted flower material borrowing the world's wind nodes
  and the pool's existing storage buffer. Stem, leaves and head share a fixed-
  root bend and inverse-transpose normal correction. Opaque, double-sided,
  matte vertex colors use native standard lighting, fog and shadow integration.
- Explicit admission bounds the storage pool, geometry and supported upright
  transforms without mutating source arrays/bounds/uniforms. A world-space
  displacement helper matches the shared capped wind equation; future owners
  must apply it to culling bounds and revalidate mutations. Independent petal
  flutter is NOT included in either this deformation or its displacement bound.
- Material01 passes 51 new real geometry/storage/NodeBuilder cases plus 40
  existing tree-wind cases (91/91 across three files). The attempted procgen
  path was not selected by that shared-root run; previous 35 geometry tests
  remain the geometry evidence, not an additional run in this receipt.
- Full shared plus explicit source/test typing passes: 744 roots, 2,427 sources,
  zero diagnostics and stable hashes. Scoped lint/format and independent source
  review pass. The first typing invocation named a nonexistent test directory
  and stopped before checking; corrected types02 is the passing receipt.
  The initial scalar test fixture was too small to alter the aggregate bounds;
  its three failures remain retained, and the strengthened fixture now proves
  a real late-mutation effect. No production threshold was relaxed.
- [ ] Render actual flowers under native WebGPU to review silhouettes, lighting,
  roots, shadows, wind, disposal and draw/storage costs. CPU graph construction
  is not shader compilation or visual approval.
- [ ] Add bounded petal flutter, sparse deterministic retained-ground placement,
  live resource/interaction clearance and chunk/LOD retirement. Falling leaves,
  connected tree-wind visual acceptance and whole-island quality remain OPEN.
- Protected 145 compiled artifacts and retained lock remain unchanged;
  localhost3333 responds HTTP200. No defaults, runtime assets, quality settings
  or protected user services were changed. Other game activity is permitted
  during source work; uncontended performance qualification remains separate.

Reference: native lit shading follows
[Three.js MeshStandardNodeMaterial](https://threejs.org/docs/pages/MeshStandardNodeMaterial.html).
The [official r186 compute-particle source](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_compute_particles.html)
is a useful GPU-state pattern for future falling leaves, not evidence for an
island particle budget or a reason to copy its disabled frustum culling.

Evidence: service-layout `grass-swept-scalars-core01/02/03`,
`grass-swept-scalars-regression01`, `rooted-flower-material01`,
`living-world-foundations-types01/02` logs and process receipts.



#### Native rooted-flower rendering checkpoint — 2026-09-22

- [x] Render the actual production geometry/material in headed Chrome on Apple
  Metal: three storage instances, two views, zero/two wind states, ten 768-square
  readbacks with direct-wind and cast-shadow controls. Native03 passes compiled
  main/shadow pipelines, immutable arrays/matrices/bounds/material state and
  exactly-once retirement of six actual GPU buffers; zero GPU errors.
- Native01 exposed an incorrect test assumption: counted r186 storage nodes
  produce two vertex-only/read-only declarations (native instancing plus wind),
  both backed by ONE 192-byte instance-matrix allocation. Native02/03 verify
  actual identities/layouts. This costs two binding slots, not two allocations;
  it also applies to connected storage-instanced trees. No cost approval follows.
- Native02 caught r186 replacing the Uint16 index array during first upload.
  The factory now authors Uint32 indices directly, avoiding that conversion.
  Topology remains 362 vertices / 584 triangles; owned geometry is now 31,624
  bytes (the earlier 28,120-byte source count preceded native index widening).
  Native03's ten RGBA images match Native02 byte-for-byte; all original
  immutability assertions pass. Both earlier failed receipts remain retained.
- Geometry index02 passes35 tests; material02 passes91; full shared types03
  passes744 roots/2,427 sources/zero diagnostics/stable hashes; scoped lint and
  formatting pass. Actual native geometry, not a visual proxy, was rendered.
- Preview-only capture corrections use a verified rgba8unorm-srgb attachment
  and native top-left row order. Do not read old linear/raw flipped material
  fixture PNGs as color/orientation approval. Normal browser world screenshots
  are a different capture path and were not changed by this correction.
- Visual review shows slender connected stems/leaves, cream petal silhouettes
  and cast shadows from front/back. This no-antialiasing isolation scene is
  NOT finished meadow art: close-up petal shape/material review, independent
  flutter, placement/clearance/LOD, falling leaves and world performance remain
  OPEN. CPU root/bounds checks are not GPU vertex/normal numerical readbacks.
- Native03 finished in about2.35 seconds under the unchanged nominal/AC/awake
  guard. User's other game activity makes this unsuitable for uncontended
  performance acceptance. Every owned browser/HTML/Vite preview is closed;
  protected145 compiled artifacts/lock and playable localhost remain unchanged.

Local evidence: inland-pond `rooted-flower-native01/02/03/report.json`, native03
PNG/RGBA/WGSL captures, `rooted-flower-preview-runtime01/02/03/process.json`
and `rooted-flower-native.mjs`; these local diagnostic assets are not GitHub-
backed runtime content. CPU evidence: service-layout `rooted-flower-index02`,
`rooted-flower-material02`, `living-world-foundations-types03`.





### Pond-bank service ground — 2026-09-22

- [x] Author a bounded three-ribbon service apron from the actual pond bank's
  chest standing tile, court, clerk and dock arrival. The JSON recipe shortens
  grass and shares worn-soil coverage; it does not add a floor, road, navigation
  restriction, terrain grade or resource exclusion. The retained recipe reaches
  six metres toward the landing, with graduated shoulders inside an
  11.6 × 15.4997 m support. Outside the ribbons, height is neutral; the original
  town-bank treatment is unchanged.
- [x] Keep seeded placement, random draws and root scale unchanged. Shorter
  swept envelopes legitimately retain more blades beside existing roads:
  the 83-probe fixture changes near4 LOD0 from 38 clumps/535 blades to 39/553,
  and LOD1 from 40/285 to 41/292. Actual chest, four pavilion footings and 1,312
  standing samples remain clear with real tile navigation. The selected v9
  and v10 cases both pass. This is not unchanged fitted masks or zero work.
- [x] Share detached, frozen descriptors through actual terrain, grass,
  placement-worker and cold/cached grounding-worker paths. The combined source
  gate passes 532 tests across nine files; a 110-test repeat covers the three
  files adjusted for typing, and four selected-layout configuration cases pass.
  Full shared/explicit-regression no-emit: 730 roots, 2,408 source files, zero
  diagnostics. Initial test-only type failures are retained; no production
  expression changed for them. The first expanded-recipe assertion ran before
  the JSON edit and correctly failed against the narrow recipe; it is retained.
- [x] Catch and correct a real minified-factory failure: a local named arrow
  introduced an unavailable name-preservation helper into serialized code.
  Actual minified workers now execute selected, omitted and malformed
  descriptors without a shim. Result metadata is validated before copying,
  preserving inherited/accessor rejection and transferred array identities.
- [x] Build nine isolated bundles from 997 inputs in both build45 and build46;
  only the apron JSON differs between their source inventories. All 145
  protected compiled outputs remain unchanged. These are private candidates,
  not a playable-default promotion. Retained CPU evidence uses the
  `pond-service-ground-` prefix in service-layout evidence, including
  `final01`, `posttypes01`, `types04`, `selected-v9-04`,
  `selected-v10-01`, and `manager-final02`.
- [x] Review actual native93→94 Chrome/Metal WebGPU captures from the same two
  camera poses and v9 assets. Original 90-second startup and 30-second camera
  gates pass; observed startup is approximately 33 seconds in each. No retained
  runtime errors; the explicitly deferred cow-model failure remains admitted,
  not silently repaired. Native pipeline evidence includes the bound pond
  service wear. Natural wind is not phase-locked; these 1280×720 diagnostic
  stills are neither the separate 2× cinematic nor a performance comparison.
  Root and independent visual review retain native94 as a modest local gain:
  clearer muted soil/short turf around chest/clerk and a small rear approach.
  Landing composition is effectively unchanged; no obvious new regression.
- [x] Close both owned browsers and stop runtime63/64. Their ephemeral test
  databases are removed; protected listeners, persistent playable database,
  compiled artifacts and localhost3333 remain unchanged. Current lid-open/AC
  observations permitted bounded captures; native92's thermal-protection
  suspension remains failed, not retroactively passed.
- [x] Correct two pre-existing historical manager counter assertions separately
  (closed by the Regional meadow and grass census checkpoint above).
  Failures reproduce with all 13 changed production modules supplied read-only
  from committed `4a5ba06cb`: 18,063 versus 16,954 and 18,436 versus 17,306.
  Current totals include refined-face shortcuts; the frozen oracle counts
  canonical-face shortcuts only. Add explicit refined attribution and use the
  frozen census in historical savings formulas; retain semantic hashes, array
  equality, original caps and work-reduction assertions. This earlier broader
  manager run was not green; no assertion was relaxed for the apron. The
  separate repair and passing rerun are recorded in the checkpoint above.
- [ ] Qualify added shader cost, sustained performance, streaming and motion.
  Three extra ribbon evaluations are real work despite unchanged texture
  samples/draw calls. No thermal, frame-budget or AAA approval is inferred.
- [ ] Move beyond small apron adjustments: improve broad grass distribution,
  readable arrival routes, shoreline composition and material/light response.
  The clearing still sits largely in roof shadow behind a tall grass rim.
  The official [Three forest generator](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/generators/ForestGenerator.js)
  informs regional clearing/patch composition, not copied demo populations
  or replacement of authoritative harvestable trees.

### Compact pond sunlight correction — 2026-09-22

- [x] Separate compact-pond direct sunlight from planar reflection sampling.
  The old expression multiplied the highlight by reflection RGB and intensity,
  removing it when planar reflections were disabled. The compact branch now
  adds it independently, with continuous light-angle attenuation, a front-side
  gate and explicit daylight suppression because the environment reuses its
  directional light for the moon. The opt-in illumination branch applies key
  irradiance and light cosine once, not twice.
- [x] Preserve ordinary lake/ocean expressions, existing five normal samples,
  reflection enablement, opacity, depth, fog, geometry and wave displacement.
  The existing RF0=.3 and .8 body mix remain deliberately unchanged for this
  isolated comparison: this is a Phong-shaped correction, not calibrated PBR.
  It follows the independent direct-highlight composition in the
  [official Three r186 WaterMesh](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/objects/WaterMesh.js)
  without introducing its planar capture pass.
- [x] Pass 90 retained-source water/lighting/ownership tests across seven files,
  including actual TSL arithmetic/ownership tests for reflection off/on, sampled
  RGB, night with positive moon intensity, continuous horizon behavior, fog and
  pond/lake object alternation. Shared/current regressions no-emit check:
  724 roots, 2,401 source files, zero diagnostics; scoped lint/format pass.
  The first type run found three test-helper typing issues, now corrected;
  its failure remains recorded. No production expression changed during that
  test-only correction.
- [ ] Complete native appearance and GPU-cost comparison. Build44 produces nine
  isolated bundles with 996 input pins and all 145 protected outputs unchanged.
  Native92 fails before any comparison view: macOS logs a 975-second sleep
  labeled “Dark Wake Thermal Emergency” during the original 90-second startup
  gate. Its failure snapshot has ready terrain, 50/122 ready grass chunks,
  72 pending and zero failed grass jobs. This interrupted run establishes
  neither a shader regression nor visual/startup/performance acceptance.
  Keep its failed result; do not extend deadlines or override thermal safety.
- [ ] Next ground-art slice: a separately bounded pond-bank apron derived from
  the real service anchors. Existing .65/.35 bank-height values have zero
  locality here: they target the town bank at (348,318), not pond bank
  (384,438). Do not weaken or widen the old field. Pair three unequal local
  wear lobes with matching CPU/GPU grass-height and wind envelopes, preserving
  roots/counts, road/collision rules, four footings and free navigation.
- [ ] Then design a separate irregular eastern-grove ground treatment.
  The existing two-pocket habitat targets the western haven and changes
  ground/root color only. Do not encode woodland floor as roads or circular
  clearings around every tree; that would affect functional resource admission.

Evidence: service-layout/pond-direct-light-final02 (90 passes) and
pond-direct-light-types02; inland-pond/build44, native92/process.json and
native92-host-suspension.md. The earlier native90/91 appearance comparison
still describes build43, not this sunlight correction. The owned browser,
runtime62 and temporary database are closed; human localhost:3333 and its
database remain unchanged. Visual/default promotion stays unapproved.

### Pond surface, service clearing and woodland comparison — 2026-09-21

- [x] Calm compact-pond surface detail: normal strength 1.5→0.65 and detail
  clock 1→0.55, using the existing per-object selector and five normal samples.
  Reflection distortion 0.015→0.006 is also scoped to the pond, but reflections
  are disabled in this capture profile: do not credit that inactive change.
  Ordinary lakes, ocean, geometry, displacement, depth alpha and fog are
  unchanged. Native review finds a modest reduction in busy water streaks,
  not finished water lighting, motion or sustained-performance acceptance.
- [x] Extend the shared service clearing to the exact chest and clerk anchors.
  Actual chest bounds, standing disks, collision routes, four pavilion footing
  leases and swept-wind near/LOD grass checks pass for the selected layouts.
  This outpost has no physical floor; this is not a floor-clipping repair.
  The bank arrival still looks overgrown. Functional clearance is not approval
  of the entry's ground composition.
- [x] Compare the private v11 three-tree regrouping against v9 on the same
  build43. Both native90/v11 and native91/v9 complete the original startup
  and all five camera gates in headful Chrome/Metal WebGPU. The dock-facing
  treeline is more layered and asymmetric; the broad clearing remains open.
  Keep v11 as a modest private composition candidate, not a playable-default
  promotion. All asset counts/models are unchanged, which does not establish
  equal visibility, overdraw, shadow cost or frame time.
- [x] Exercise all 48 resource routes with bounded repeated partial-BFS
  replanning, twelve cardinal approaches, depletion replay and owner reload
  against the selected v11 manifest. These are CPU integration checks, not
  one-call pathfinding or live agent navigation proof. Three coordinate-derived
  resource IDs change; production promotion still requires persistence review.
- [x] Preserve native88 as FAILED: the new woodland view passed its grass gate
  but a pond-only capture assertion wrongly required a visible dock. Repair
  only that view's subject assertion using actual submitted trees and current
  resource ownership. Native90/91 are corrected comparisons, not relabeling88.
- [x] Reject the second grass optimization (worker delegation adapter).
  Four cached mixed-cell samples regress from 96.59 to 102.85 ms median;
  a concurrent road-source change also confounds that comparison. Exact
  native86-cell samples move in opposite directions. Restore the original
  worker and retain both timings and patch; no speedup or startup fix claimed.
- [ ] Improve water surface-lighting composition: the reflection switch also
  suppresses direct solar highlights and the final tint flattens the result.
  Use the [official Three r186 water source](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/objects/WaterMesh.js)
  and [dielectric optics reference](https://www.pbr-book.org/4ed/Reflection_Models/Specular_Reflection_and_Transmission)
  for a bounded no-new-pass correction, preserving depth/contact behavior.
- [ ] Design readable bank-entry ground and a woodland-floor transition.
  Tall uniform grass and coarse leaf-card shading remain obvious weaknesses.
  Hidden branch intersections, animated shimmer and a moving-camera review
  remain unqualified; do not label these static views finished world art.
- [ ] Resolve historical grass startup budget failures and the steep headland
  depth boundary; v10 gentler-bank visual approval remains blocked. No higher
  work/time caps, reduced-quality bypass or repeated-until-green acceptance.

Retained final-source verification: 73 passing tests across canonical,
selected v9/v10/v11 and exact failed-cell configurations; explicit opt-in skips
remain recorded. Shared/current regression no-emit typing checks 724 roots and
2,401 source files with zero diagnostics. Scoped formatting and lint pass.
This is not a whole-repository type/test acceptance. Isolated build43 has nine
bundles and 996 source-input pins; all 145 protected compiled files remain
unchanged. Native90/91 each supply five 1280×720 native views (DPR1, MSAA4,
held daylight, live wind); neither is a 2× cinematic, stream or FPS test.
Both owned browsers, runtime59/61 and their temporary databases are closed.
Human localhost:3333 and its database remain unchanged.

Evidence: inland-pond-integration01-UNQUALIFIED/native88, native90, native91,
build43, assets-v11 and grove-v11-*; service-layout evidence
pond-service-canonical03, pond-surface-material04, pond-service-selected-v9-03,
pond-service-selected-v10-03, pond-service-retained-grass01,
grove-v11-selected03, pond-service-types02 and worker-delegation-rejected01.
The initial graph-wrapper/type/fixture test failures and all-skipped selected02
run remain recorded; only the corrected final-source passes count above.

### Pond timber and gentler-bank study — 2026-09-21

- [x] Refine compact dock timber with asymmetric growth lines, bounded
  longitudinal weathering and a mean-neutral distance fade. The existing
  single-noise field, six sine operations, two derivative operations, zero
  texture fetches, two meshes/shared material and geometry bytes are retained.
  The narrower ring response adds arithmetic; unchanged counts are not GPU
  cost acceptance. This restrained study references the
  [official Three r186 wood material](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/materials/WoodNodeMaterial.js)
  without importing its multi-octave/Voronoi work.
- [x] Review the 14-plant pocket regrouping and timber in native87/build42/v9:
  four real Chrome/Metal views pass the original startup and camera-cut gates.
  Root and independent review find clearer foreground timber grain without
  renewed crosshatching or unwanted gloss. Plant grouping is a modest gain;
  distant roots are too small to certify individually. The shoreline is still
  sparse and the pond-bank pavilion's service-ground/entry is obscured by grass.
  No finished-art, shimmer, gameplay, streaming or sustained-performance claim.
- [x] Build the isolated terrain-only v10 study: southern innerRadius 14.8→18.5,
  all other manifest fields unchanged. It changes two bytes in one 17,379-byte
  manifest; no models/textures are copied. Actual radial analysis predicts
  45.44→29.84-degree peak slope and a 2.46 m receding waterline.
  Eight selected CPU tests pass: four actual terrain leaves/169,560 probes,
  existing 2 cm/6° limits and exact shared seams, both docks/3,250 rays,
  fourteen fishing spots/seven families/twelve fish, 42 relocations and
  canopy-clear dry approaches. These are not live-angler or visual acceptance.
- [ ] Complete v10 native review after resolving loading reliability.
  Native86 fails the unchanged 90 s startup gate with zero views:
  cells 13_17 and 14_17 hit the 250 ms active-work cap (252.30/250.30 ms).
  The baseline also has historical failures, so this does not by itself prove
  a terrain regression. No changed cap, reduced density or repeated-until-green
  approval. The gentler bank remains a private, unapproved candidate.
- [x] Reject and remove the experimental grass envelope-math optimization.
  Four predeclared mixed-cell samples show only a 2.7% median cached-worker
  change with a worse maximum; several full-suite timings also regress.
  Numerical/work/yield/240 paired-buffer comparisons and 232 tests pass, but
  correctness alone does not justify complexity. The exact old source is
  restored; patch, timings and failures remain recoverable in private evidence.
- [ ] Profile the remaining grass fitting/publication cost and preserve all
  work, validation, geometry and visual-quality contracts. Existing budget
  failures are not resolved by this art checkpoint.
- [ ] Clear the pond bank's service-ground/entry footprint through the
  shared terrain/grass recipe, then improve planted grouping and island
  landmarks without constraining open-world navigation.

Native85 remains FAILED: macOS recorded a 711-second sleep labeled
“Dark Wake Thermal Emergency” during its startup window. Native87 is a separate
awake comparison, not relabeling that failure. The short process-scoped
keep-awake used for native87/86 changes no permanent setting or thermal
protection. Current macOS warning queries report no warning level, not an
actual temperature or thermal certification.

Retained-source checks: historical dressing/fishing 24 passes and one explicit
selected-overlay skip; dock suite 20/20; v10 selected world tests 8/8 with
73 unrelated cases filtered; shared plus current regressions/server policy
no-emit typing 721 roots/2,397 source files, zero diagnostics. Build42 contains
nine isolated bundles, with all 145 protected compiled artifacts unchanged.
The earlier type run checked the subsequently rejected math candidate; only
pond-polish-types02 describes the restored retained source.

Evidence: inland-pond-integration01-UNQUALIFIED/native85–87, build42,
HEADLAND_V10_QUALIFICATION.md and headland-v10-*.json; service-layout evidence
pond-timber-latewood01, pond-polish-types02 and envelope-math-*.
All owned browsers, runtime57/58 and their temporary databases are closed.
Human localhost:3333, its database and canonical builds remain unchanged.
The world goal stays active; no unqualified playable-default promotion.

### Pond-depth attribution and new art candidates — 2026-09-21

Native82 and83 both FAIL the unchanged original 90 s startup gate. Three LOD0
grass cells reach the unchanged 250 ms active-work cap: 12_17 (250.70 ms,
112,014 operations), 14_16 (250.90 ms, 114,690), and 13_16 (250.20 ms, 138,474).
These failures remain launch blockers; no further qualification retry or
increased limit is used to claim reliable startup.

Native84 is a separate owner-only diagnostic: full startup and grass-cut
qualification gates are explicitly NOT RUN. Its scene has 42 pending grass
chunks at the diagnostic snapshot. It reads the two real pond depth textures
and six pixel-center rays against exact uploaded ordinary opaque geometry.
The six winning terrain hits match the ranges of the four GPU depth samples
at each pixel. Both sides of the sampled boundary hit SURFACE triangles of the
same 128-resolution terrain leaf, not its skirts or a coarser overlapping
ancestor. Excluded actors and unknown MSAA sample positions remain unqualified.

Actual terrain interpolation agrees with the authored height function to
within 1.13 mm at the six sampled hits (vertices within 0.000001 m, local normal
difference 0.16–0.66 degrees). The nearer headland slopes 41–45 degrees and
occludes the farther 19–21-degree bed. This is a steep authored bank, not proven
texture corruption or mesh damage. Keep water shading unchanged for the next
terrain-only comparison.

- [ ] Test a gentler southern headland: innerRadius 14.8→18.5, all other sector/
  material settings unchanged. Scalar prediction is 45.44→29.84-degree peak
  slope and 2.46 m receding waterline, NOT a finished visual fix. Requalify
  actual geometry, bank/grass continuity, all fishing approaches, dock/guide
  clearances and held native views before any promotion.
- [ ] Review the separate 14-plant pocket-massing candidate in game. It keeps
  28 pond +24 service instances, six models, seven rocks, NW drift and every
  model/scale/yaw/order. Selected-basin CPU access checks and 14/14 historical
  dressing tests pass: 14 actual fishing spots retain at least three canopy-clear
  dry approach tiles, with existing dock/guide/path/root-footprint clearances.
  These candidate edits are not yet visually accepted or committed.
- [x] Add a replay for failed cell 12_17 with actual retained owner resolutions:
  pond 128 and western neighbor 64, not an incorrect all-128 workload.
  Current-source CPU replay retains 1,209 clumps, zero rejections and exact
  output/provenance hashes. Worker active time is 96.67 ms; publication-inclusive
  handoff is 101.30 ms. This is NOT reproduction of native startup timing.
- [ ] Optimize only after profiling the three failed cells. The exact swept
  envelope also controls rejection and output bounds; do not replace it with
  a looser envelope. Investigate repeated geometry arithmetic and output
  packing allocations while preserving output, work accounting and limits.

A combined private-fixture run completed all nine enabled grass cases, but
four historical small-pond dressing cases rejected the incompatible inland
pond dimensions. That failed invocation is retained; historical dressing and
selected inland access use separate, correctly configured runs. No production
admission is widened to make historical fixtures accept different geometry.

The correctly scoped standalone grass replay subsequently records 8 passes,
1 failure and 3 skips: the pre-existing eastern-shelf southbank case exceeds
its active-work budget. The new mixed-resolution case passes, but the suite
is NOT green and startup reliability is still open. Do not rerun until green
or raise the cap. Next measure and reduce the fitting/packing cost itself.
Source-only shared/server typing including both follow-up tests passes:
719 roots, 2,395 source files, zero diagnostics. The new dressing test's initial
readonly-tuple typing errors were corrected and both correctly configured
dressing test runs repeated; failed receipts remain retained.

Native81–84 diagnostics do not establish a shader speedup, final pond art,
reliable startup, seamless movement, full streaming or sustained performance.
Native82/83 failures, native84's incomplete-scene scope and all source/data pins
remain retained. All browsers and runtime56/temp database are closed; human
localhost:3333, database, compiled outputs and unrelated work remain protected.
Evidence: `inland-pond-integration01-UNQUALIFIED/native81–84/`,
`pond-headland-scalar-analysis.mjs/json`;
`service-layout-network01-UNQUALIFIED/pond-plant-massing-*`,
`native82-mixed-grounding-baseline02-receipt.json` and
`pond-world-followup-tests01.json`.
World goal remains active; compact island only, one arena and SOL only.

### Inland fishing integration — candidate only

The detached candidate now requests 14 real fishing entities, two for each of
seven families covering all 12 fish. The body-bound resource owner admits only
wet targets with a dry approach within the existing interaction range, reserves
pending positions, and keeps relocation inside the same water body. The focused
28-test resource gate passes, including retries, concurrent reservations and
local supported dry approaches. This is not complete route-connectivity or live
multi-agent fishing proof.

Both dock decks now have closed 12cm-thick planks and directionally aligned,
filtered timber grain, sharing one opaque rough material. Stock and art03 each
pass 18 layout/native-physics cases. Relocated habitat uses 28 instances in three
unequal groups; 111 habitat/palette/worker cases pass. Native appearance, route
integration and sustained cost still require separate evidence.

**Do not promote this placement yet.** The candidate partly overlaps the old
broad arena zone: ordinary fishing deaths, dropped items, opted-out agent
retention and duel-challenge eligibility consequently need explicit separation
and integration tests. Do not relax global economic/custody rules to hide this
layout conflict. The old pond-to-bank paint also crosses the lobby after pond
relocation; the candidate needs a verified dry route around physical floors.
The revised candidate paint route now passes 77 path/configuration/worker
cases around the lobby. The first real Chrome/Metal run nevertheless failed
scene readiness: the enlarged bank exceeded the existing terrain refinement
vertex cap in leaf `quad_68_d4_450_450`. Its loading-screen failure is retained;
there is no native art or performance acceptance. The test browser and private
runtime/database were closed; the human localhost session stayed unchanged.
All LAYOUT-01–08 checkboxes remain open. Evidence is in the local
`service-layout-network01-UNQUALIFIED/` and
`inland-pond-integration01-UNQUALIFIED/` directories.

Follow-up refinement source and native02 now resolve that specific terrain-load
failure without raising caps. Adaptive broad-bank refinement and balanced thin
strips retain old small-bank goldens;169,560 probes pass the existing20mm/6-degree
gates with10.99mm/3.10-degree maxima. Native02 reached29/29 terrain chunks,
122/122 grass chunks at its initial camera and ready water topology. Its later
pond-camera cut still failed the unchanged30-second grass-settling deadline
(four grounding jobs and one LOD swap pending). This is not a completed art
capture,14-entity client proof or performance approval; diagnose the transition
and verifier ownership before changing quality or deadlines.



## Island layout requirements — 2026-09-20, all open

These are required sub-gates of the world composition and verification tasks
below, not optional decoration or completed work. The island must feel like one
natural, inhabited place with purposeful destinations and useful open ground.
They supersede earlier single-bank assumptions and fixed pond placement/outline;
historical pond receipts remain evidence for their old profile only.

- [ ] **LAYOUT-01 — small pavilion town.** Compose the main banking, crafting
      and preparation services into a compact, recognizable town of open-sided
      pavilions, gathering spaces and clear landmarks. Avoid a service grid or a
      collection of identical roofs. Preserve circulation, diagonal travel, off-path
      exploration and overhead visibility; do not force all travel onto paths.
- [ ] **LAYOUT-02 — distributed banks.** Provide multiple actual bank access
      points across the island, including the town and useful outlying skill areas.
      Choose their number and positions from measured gathering/deposit/preparation
      journeys, not equal geometric spacing. Keep one player's authoritative bank
      inventory consistent at every location; verify access range, concurrent
      requests, restart persistence and agent discovery without duplicate balances.
- [ ] **LAYOUT-03 — distinct mines.** Place multiple recognizable mining areas
      with geologically coherent outcrops and different ore mixes, covering every
      launch ore and its progression requirements. Author counts, scarcity and
      respawn budgets explicitly; prove approach, depletion, regeneration and
      gathering-to-bank routes using the live resource entities.
- [ ] **LAYOUT-04 — tiered resource trees.** Spread real choppable tree species
      and tiers throughout the island in mixed groves, solitary landmarks and
      habitat-appropriate groups. Common tiers are abundant; higher tiers are
      progressively rarer. Validate authored counts by tier, spacing, accessible
      harvest faces, regrowth and agent targets. Inspect all LOD/crown bounds and
      batching/culling costs; decorative copies do not satisfy resource coverage.
- [ ] **LAYOUT-05 — local quest support.** Audit every launch quest NPC against
      the skill area and quest stages it supports. Place each near a suitable
      teaching/gathering/processing area, retain IDs and progress, and prove complete
      quest routes and hand-ins after relocation.
- [ ] **LAYOUT-06 — distributed rune altars.** Give the launch rune altars
      separate, thematically coherent locations around the island instead of one
      cluster. Preserve crafting eligibility, interaction ranges and identities;
      verify each altar's discovery, supply/bank route, clear approach and use.
- [ ] **LAYOUT-07 — natural inland pond.** Relocate the pond farther from the
      ocean-facing island edge and author an irregular basin with unequal coves,
      shelves, cutbanks and planted turf margins, not a circular ring or noise added
      to the same collar. Select placement in whole-island plan and eye-level views;
      record the minimum dry land separation from the ocean and retain a readable,
      traversable inland buffer. Revise the versioned terrain/water profile and
      coverage together; do not move only the visible water mesh or reuse old
      coordinate-specific approval. Re-ground fishing spots, plants, stones, nearby
      trees and paths; test indexed/rendered terrain against authoritative height,
      PhysX, water coverage, shoreline crossings and fishing/navigation access.
      Size the water and banks for all seven current fishing families (net, bait,
      fly, harpoon, cage, monkfish and shark), all 12 fish and their level/tool/
      consumable requirements. Reserve two accessible positions per family as a
      capacity target; prove actual spot availability and concurrent agent use,
      not only a configured type list. Capacity acceptance must exercise all
      fourteen positions concurrently (two anglers per family), including dry
      approaches, tool/consumable checks, rewards and spot relocation/retry.
      Test additional arrivals without trapped agents or blocked through-routes.
      Keep a usable shore option for every tier,
      a fishing supplier with bait and feathers, and a clear bank route. Author
      two distinct, restrained procedural docks with character, fitted landings,
      support posts and deliberate rail openings. Docks must use the pond's
      actual water level and shared deck/ground authority; verify entry, fishing
      reach, blocked edges, collision rebakes, cleanup and restart. Measure their
      draw/triangle/material and setup costs. Placement, capacity and dock count
      remain design targets until integrated visual and gameplay acceptance.
- [ ] **LAYOUT-08 — integrated acceptance.** Before promoting the layout, retain
      an annotated island plan, resource/service census and short journey budgets.
      Verify multi-agent gathering, deposit, crafting, questing and duel preparation,
      migration of persisted positions, restart/reconnect and resource lifecycles.
      Review close, overview, walking and stream views across daylight conditions,
      and measure target-hardware frame, loading and memory budgets. A new layout
      invalidates affected old route/grounding evidence; tests alone do not establish
      the required artistic or AAA-quality acceptance.

## Current world-art scope — open acceptance contract

**World first; avatar/armor later. One compact island and one arena remain the
only launch world.** This direction supersedes older preservation language for
enclosed procedural buildings; the Review75 shoreline gate below is separate.

- [ ] Replace every procedural building/service shell in this experience with
  an intentionally authored **open-sided pavilion**. Use the existing furnace
  canopy as the simplicity and visibility baseline, not as a clone requirement.
  There is no enclosed-building or furnished-interior preservation requirement.
  Preserve authoritative bank/NPC/service/resource IDs and data, interaction and
  custody semantics, banking/preparation behavior and restart-safe state—not the
  enclosed wall topology or its old footprint. Regenerate actual collision,
  grass exclusions, walkability/navigation and approach geometry for the new
  posts/roof; remove old wall/door blockers and prove no invisible walls remain.
- [ ] Give the pavilion family cohesive character through readable silhouettes,
  rooflines, supports, materials, props and landmark hierarchy while maintaining
  overhead/stream camera visibility, agent circulation and uncluttered approaches.
- [ ] Rebuild the procedural duel arena and **all** associated arena assets,
  entrances, boundaries, spectator furniture, landmarks, details and effects as
  the island's single artistically excellent focal point. Integrate it with the
  pavilion/world language while preserving authoritative combat bounds, spawns,
  movement and results. Acceptance requires collision/navigation proof, clean
  fight-camera and stream readability for every phase/style, effect stress and
  measured rendering cost; this is an aspiration, not a claim of AAA completion.
- [ ] Compose one deliberate island layout rather than disconnected set pieces:
  distribute varied **real choppable resource trees** across groves and scattered
  groups; create ore-specific mining/gathering areas for every launch ore; place
  services, arena, bank/preparation and spectator spaces along short, readable,
  traversable routes while retaining useful off-route exploration.
- [ ] Keep visible trees/ores, selectable resources, collision, depletion,
  regrowth, yields, agent targets and persisted identities synchronized. Decorative
  stand-ins may not replace or duplicate live resources.
- [ ] Inventory **every runtime particle effect** across world, gathering,
  processing, movement, combat, arena, weather/water and UI/broadcast surfaces;
  give each an explicit retain/redesign/remove decision and visual-quality plus
  performance budgets for spawn rate, pooling, lifetime, overdraw, draw calls,
  GPU/CPU frame cost, memory and cleanup. No screenshot-only particle approval.
- [ ] Accept the finished world only after matched close/overview/stream views,
  day/night and moving-camera review, multi-agent preparation/gathering/dueling,
  full route/collision/resource-lifecycle tests, particle stress/fault cleanup,
  and measured target-hardware frame/loading/memory evidence pass together.

These are open launch tasks, not completed implementation. Existing shoreline
texture accounting remains **3 checked / 8 open**.

**Bank pavilion art03 — bounded improvement retained; full-bank art remains open.**
The explicitly admitted `open-timber-bank-haven-v2` candidate adds two readable
post-mounted key signs and curved, asymmetric service wear. Actual geometry is
**1,492 triangles / 247,200 bytes**, still three meshes/materials and below the
unchanged 1,500-triangle guard. Historical smithy geometry and unaffected paths
remain exact; the old bank recipe is rejected instead of silently relabeled.
Tests pass **13** geometry, **32** path, **35** visual/cutaway, **11** native-owner,
**4** selected candidate-owner, **2** candidate-access and **37** client cases
(overlapping suites; do not sum). Strict shared/client source types, scoped lint
and isolated builds pass; all **145 protected compiled artifacts** are unchanged.
Native01 timed out before any art views; that failed cold-start receipt remains.
Native02 passes the unchanged startup gate and captures three actual Chrome/Metal
views with all three bank pipelines, complete HUD leases and stable input pins.
Independent review finds readable signs and resolved orphan braces, but chunky
plaques, a generic shelter, broad dark ground and angular grass still need work.
No motion, loading-time, full-stream, target-hardware performance or AAA approval.
Only the owned diagnostic browser, servers and temporary test database were
cleaned; playable **3333/5555/5556** and the human database are unchanged.
The expanded **LAYOUT-01–08** requirements above remain entirely open.
[Art03 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/bank-pavilion-art03-UNQUALIFIED/README.md)

**Bank pavilion integration01 — candidate integration verified; art and launch acceptance remain open.**
The isolated, non-promoted candidate places `compact-bank-pavilion-v1` at
**(350, 320)**, moves the existing clerk to **(352, 322)**, preserves bank,
service and resource identities, and removes the retired lodge collider. The
generated post/roof collision, four-foot grass exclusion, camera cutaway and
complete approach paths are integrated. Grass-exclusion capacity is explicitly
32 for **25 actual polygons**; none was dropped. Candidate access passes **2/2**:
**532** terrain samples have delta 0, all **27** required paths complete across
**1,473** checked edges, the four bank and four clerk approaches plus exact
pavilion center are reachable, and the true two-tile bank boundary accepts the
exact center; the offset tile center and four just-outside probes are out of
range. CPU checks pass **53**
historical-path, **2** candidate-path, **40** geometry, **37** actual-worker,
**11** native-owner plus **4** candidate-owner, and **32** initial-visual tests.
Separate fail-closed readiness checks pass **1** actual aggregate, **11**
real-system and **19** client-regression tests; scoped source typing, lint and
format checks are clean.

Private runtime03/runtime04 health and plugin-module identity pass. After the
type-only client exports, build04's **eight runtime JS bundles are byte-exact to
build03**; protected canonical runtime outputs stay unchanged, and no candidate
manifest is promoted. Native02 retains three valid
bank views with three submitted actual pipelines per view; its timed-out arena
overlay is invalid evidence. Native03 supplies a valid arena-first current-arena
wide baseline only, not a new arena implementation. Independent review still
finds the pavilion's scale, banking identity/dressing and ground/grass
relationship unfinished. These captures remain `ART_UNQUALIFIED`: they close
no architecture, motion, target-hardware performance, full-stream or launch
gate. Owned browsers, private servers and ephemeral databases are cleaned while
the protected **3333/5555/5556** processes retain their original PIDs. Next is
the bank pavilion identity/grounding art pass, then the single arena's
perimeter/material slice. All **seven** world-art tasks remain open; shoreline
accounting stays **3 checked / 8 open**.
[Bank pavilion integration01 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/bank-pavilion-integration01-UNQUALIFIED/README.md)

**Bank pavilion geometry01 — source geometry verified; all seven scope gates remain open.**
The fixed `bank-pavilion-v1` OpenWorkshop recipe with the existing Haven
architectural finish produces three batches at **1,300 triangles / 216,576
attribute-index bytes**. Its roof is nominally 8 × 8 m; eaves and trim extend
actual X/Z bounds to about **8.99 × 8.90 m**, so that is not an 8 × 8 collision
footprint. Final geometry suites pass **40/40**; focused inclusive TypeScript
covers **2 explicit roots / 688 files / 0 diagnostics**; scoped ESLint exits 0.
Retained first runs document the corrected truss-aperture assertion and
test-helper narrowing. Captured pre-edit default and Haven smithy buffer SHA-256
identities remain exact. This is geometry only: it is not integrated or visually
accepted, and no PBR/material, placement, physics, collision, cutaway, grass
exclusion or navigation behavior changed. Next is versioned-manifest bank
placement, generated post/roof collision and cutaway, removal of the retired
lodge exclusions/blockers, then native banking/service access and art proof.
All **seven** world-art scope tasks above remain open.
[Bank pavilion geometry01 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/bank-pavilion-geometry01-UNQUALIFIED/README.md)

**Review76 — grass lighting diagnosed; leaf-normal control rejected; acceptance remains open.**
Native08 captures **6 PNGs** and native09 **16 PNGs** at two held sun phases;
both exit 0 as `CAPTURED_UNQUALIFIED`. Actual direct and indirect grass-light
outputs are present, so the broad angular appearance is not simply an
unlit/output-bypass problem. The unit leaf-normal control makes the grass much
darker while preserving broad plastic-ribbon forms and is visually rejected.
Actual pipelines are restored: fragments are exact; vertices are exact or differ
only by restricted bijective generated `NodeBuffer` identifiers with the same
matrix and bindings. Both eight-pin sets remain stable, the protected playable
client/server/database are unchanged, and only owned diagnostic browsers and
leases are cleaned. The actual local server keeps duels disabled; stream
readiness remains false at `waiting_for_duel_data`, and the retained 503
endpoint is not stream admission. No production grass change or default is
promoted, and no natural-motion, performance, full-stream or whole-world quality
gate closes. All **seven** world-art scope tasks and shoreline **3 checked / 8
open** gates remain unchanged.
[Review76 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-grass-review76-UNQUALIFIED/README.md)

**Review75 — bounded shoreline/grass evidence complete; visual acceptance remains open.**
The explicit mineral-shore role reuses the existing stone PBR layer without
changing geometry, grass support, wetness, water, collision or routes; fine
grass restores the broader area envelope and bends its lower centerline. The
correctly selected historical-fixture run passes **834/834**, focused grass
passes **254/254**, test-inclusive typing covers **717 roots / 0 diagnostics**,
and native physical evidence remains **4 passes / 1 historical skip**. Native
Metal/WebGPU evidence includes four Review74-matched stills plus a new shore
view and **11.943 s / 11.821 s** bank/coast clips. Exact original-timebase
decode and every frame hash pass; the bank's 37 retained default-mux DTS
warnings are separately reproduced as 37 default-30-fps timebase collisions,
not exact-timebase decode failures. The explicit polling session shuts down
cleanly and verifies **32 pins**, but it does not repair default macOS FSEvents.
Grass is fuller and less needle-like, yet still reads as hard flat ribbons with
weak canopy depth; the dark pond contour and smooth fringe remain. No visual,
temporal, performance or default promotion is accepted. All **3 checked / 8
open** texture gates remain.
[Review75 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review75-UNQUALIFIED/README.md)

**Review74 — bank/stone improvement verified visually; whole-scene acceptance still open.**
The cutbank now meets the water without the prior detached mound; isolated
Blender-authored stone normals/tangents and matching PBR maps reduce triangular
silver highlights. Original rock geometry/UV/base color remain byte-exact,
778 triangles and texture budgets unchanged. CLI, official MCP and visual review pass.
Four matched native WebGPU stills and a 12-second rail show local improvement,
but the continuous brown collar remains. Pointed grass loses about 32% projected
near-leaf area and looks more pin-like, not fuller; its volume is NOT accepted.
Coastal motifs/soft blends and original-angle/distance/shimmer gates remain open.
Final **825/825 terrain tests**, **252/252 focused grass tests** (47 overlap),
**717-root typing**, lint, builds and actual **4 physical passes / 1 historical skip**
pass; 1,300 routes and 27 fishing tiles remain. Pond anchors change 322→320,
not unchanged coverage. Video: 329 decoded frames/11.97s, 81ms maximum recorded
gap, exact camera/anchor return, no decode warnings—not FPS or temporal approval.
The native run exits **1 / FAILED_CLEANUP**: Vite needs owned-group SIGKILL;
zero EPERM/remaining groups, browser/test database/volume/five ports cleared.
Evidence-audit success does not waive this lifecycle failure. Source sampling
review finds no new proven paired-map/normal-rotation bug; mip/contrast and
source-motif risks remain. No default/performance promotion; Mac remains on battery.
All **3 checked / 8 open** texture gates remain. Next: break the continuous collar,
restore convincing grass volume, test original-angle moving-distance appearance,
and diagnose the client shutdown hang separately.
[Review74 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review74-UNQUALIFIED/README.md)

**Review73 — coordinated bank trial implemented; native art result still rejected.**
Shared CPU/TSL habitat groundcover, deterministic worker/sync establishment,
two authored northern bank profiles and unequal reed groups are implemented.
Water/root safety, RNG and attempt budgets remain strict. Final **823/823 tests**,
**713-root typing**, scoped lint and normal shared/server builds pass.
Actual physical checks pass **4 tests / 1 historical skip**, including 1,300 routes
and 27 fishing tiles. Two rock repositionings fix retained burial failures;
blocking tiles change 56→55, and pond anchors 327→322—not unchanged populations.
Four native WebGPU views and an out-and-back clip prove the new rendered branch.
Reed grouping improves, but a detached brown mound/green apron weakens the bank;
the dark collar, flat grass and faceted shiny stones remain. This is not accepted AAA art.
The clip decodes 318 frames over 11.942 s, with 59 render samples and exact camera/anchor return;
a 170 ms maximum recorded gap and three mux warnings remain, not smoothness approval.
Strict native shutdown exits 0 with no EPERM/forced kills; browser, owned test data
and five ports are cleaned. Earlier lifecycle/HMR failures remain recorded.
The generated concept is explicitly **not in-game**. No art default or performance
claim is promoted; the Mac was on battery. All **3 checked / 8 open** texture gates remain.
Next: connect the physical cutbank/rock footing to the water, remove the apron/mound,
and qualify original-angle/distance/motion appearance and measured cost across materials.
[Review73 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review73-UNQUALIFIED/README.md)

**Review72 — wet cutbank transfer verified; visual improvement insufficient.**
A bounded opt-in soil-to-rock transfer now reaches the authored wet cutbank toe,
using shared CPU/TSL weights across PBR channels. Grass placement, geometry,
wetness, maps and defaults are unchanged. All **742 tests**, shared typing,
**711-root test-inclusive typing**, scoped lint and shared/server builds pass.
Seven native WebGPU stills include three matched views with identical saved
pond grass anchors, seven 1024²/11-mip/16× maps and unchanged compiled sampling.
The visible difference is too subtle: the brown pond collar, soft material border
and uniform grass edge remain. This is not an accepted AAA improvement.
The baseline coast transition fails its 30s grass deadline; both strict shutdowns
fail on retained EPERM. Owned resources/ports are cleared, but neither failure is waived.
No motion or performance qualification was run. All **3 checked / 8 open** gates remain.
Blend-chain review confirms no later weight overwrite; localized support limits the effect.
Next: coherent cutbank/sedge/turf composition, original-angle/moving-distance
comparison and measured cost—not more isolated scalar tuning.
[Review72 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review72-UNQUALIFIED/README.md)

**Review71 — real client ownership improved; lifecycle and HMR still unqualified.**
The launcher directly owns Vite under its existing verified Node22 runtime.
Actual client production build and native WebGPU startup/120 advancing frames pass;
strict shutdown still fails on retained process-group EPERM (and one dev run needs SIGKILL).
A real controlled Darwin zombie-only group reproduces EPERM in libc, Node and Bun;
this explains a possible race, not permission to waive historical inspection failures.
Native file notifications also fail below Vite in two local locations; HMR remains open.
The existing regression batch is **58/59**, with one unchanged CI Node-pin failure.
Exactly 25 ignored dataless public backups were moved intact out of the served folder;
none were deleted or hydrated, and active originals retain their hashes.
No art, motion, performance or launch gate is closed; all 3 checked/8 open texture gates remain.
[Review71 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review71-UNQUALIFIED/README.md)

**Review70 — leaf-volume shading refined; art, performance and lifecycle remain unqualified.**
Implemented opt-in transverse leaf shading and root contrast without changing geometry,
density, coverage masks, LODs, resolution or historical rendering modes.
The first native recipe was rejected for dark, sharp strips; its evidence/source is retained.
A softer refinement improves separation modestly, but close grass remains broad and flat.
All **470 tests**, **706-root typechecking**, scoped lint and shared/server builds pass.
Sixteen actual WebGPU images cover both iterations; compiled vertex/fragment controls,
geometry and saved anchors are verified. No default is promoted.
Refined 10-second samples: CPU p95 **8.9→15.2ms**, observed-pass union p95 **14.88→15.79ms**.
Those worse tails remain open; short samples do not qualify FPS, motion or performance.
Both refined runs fail strict client shutdown (SIGKILL/EPERM), correctly propagated by the
wrapper. Browsers, cameras/clocks, owned databases/volumes and all five ports are cleaned.
Next: better blade silhouettes and ground transitions with explicit coverage accounting;
counterbalanced performance/motion checks; directly owned client shutdown diagnosis.
Original shoreline repetition, whole-world presentation and all integrated launch gates remain open.
[Review70 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review70-UNQUALIFIED/README.md)

**Review69 — four-way native isolation captured; visual and lifecycle gates NOT passed.**
Sixteen actual WebGPU images compare baseline, grass lighting, boulder-map and bank-geometry variants,
with real submitted owners and pinned maps/geometry; no asset, selector or default is promoted.
Verification passes: **455 lighting + 4 physical + 15 policy + 37 validator tests**,
one historical physical skip, and **706-root typechecking with zero diagnostics**.
Grass gains modest contrast, but remains unaccepted; the uneven northern lip still leaves
a continuous brown outline and flat, uniform turf—not a meaningful whole-world art gain.
The asset-only boulder correction removes local silver triangular highlights; faceted geometry/normals remain.
Four 10-second observations report CPU p95 **7.2–8.7ms** and observed-pass-union p50 **11.21–11.40ms**,
not presentation/FPS, full-GPU-frame or performance qualification.
**Baseline03 and grass shutdown fail**: launcher exit 1 after game-client SIGKILL and one EPERM each;
rock02/bank exit 0. All cameras/browsers, owned databases/volumes and five ports are cleaned.
The wrapper now rejects returned cleanup failure, but that diagnostic fix is source-checked only—not native-rerun.
Original repetition, mips, motion, day/night, live contacts and AAA quality remain open: **3 checked / 8 open**.

- Pending: blade transverse volume and convincing root-to-ground contrast.
- Pending: stone geometry/normal faceting and genuinely authored roughness.
- Pending: coherent shoreline breakup, matched distance/motion coverage and strict shutdown verification.

[Review69 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review69-UNQUALIFIED/README.md) · [Native/postflight audit](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review69-UNQUALIFIED/postflight.json) · [Isolated boulder near view](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review69-UNQUALIFIED/rock02/candidate-near.png)

**Review68 — shared shoreline composition implemented opt-in; visual gate NOT passed.**
The strict sector mapping, shared CPU/TSL surface weights, worker/sync grass support
and restart-owned terrain/water binding are implemented. A masked-zone lock bypass
found during review was fixed and covered with actual-owner regression tests.
All nine complete suites pass **709/709**, with no skips; production plus nine tests
type-check with zero diagnostics. Shared/client/declaration and matching server builds pass.
Six matched **fixed-local-daylight** native WebGPU images confirm the real compiled
candidate, seven actual 1024² maps/11 mips/16× filtering, and unchanged camera/render settings.
Independent visual review finds only a subtle tone change—not a meaningful art gain.
The continuous brown collar, flat turf and faceted wet stones remain below the target.
An initial stale-build launch and a subsequent natural-clock phase rewind are retained;
fixed-light art evidence does **not** qualify natural timing, motion or performance.
Both successful capture sessions exit 0, restore clock/camera owners, close their browsers,
and remove their own no-money test databases; all five ports are clear.
Original repetition, near/grazing/distance motion, added ALU cost and full-world quality remain open.
Next deliver visibly distinct, physically grounded northern bank/groundcover composition;
do not substitute more source checks or another global roughness adjustment for visible progress.
[Review68 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review68-UNQUALIFIED/README.md)

**Review67 — roughness isolation complete; whole-shore quality remains UNQUALIFIED.**
Six native shaded/roughness/restored images show a high authored roughness input
on dry terrain and a lower bank input near water, not a global gloss-floor defect.
This is visual diagnostic evidence, not numeric readback, final-specular or
all-lighting acceptance. Separate rock props still look faceted/glassy despite
metalness 0 and scalar roughness 1; the boulder's map still affects its result.
Both views restore exact material roots/output/textures and actual submitted
native fragments. All 15 selected pins remain stable; diagnostic process and
launcher exit 0, browser closes and all five ports clear.
The generated concept and whole-shore contract are **design, not implementation**.
No production/default changes, builds or full regression suite are claimed.
Original repetition, material composition, the 45–120m normal fade and full
near/grazing/distance motion remain open; the shared gates stay **3 checked / 8 open**.
Next implement one authoritative bank composition with matching groundcover and
protected water/access, retaining seven maps/33 surface reads—not another cosmetic ring.
[Review67 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review67-UNQUALIFIED/README.md) · [Binding composition contract](/Users/lucid/Documents/hyperia/hyperia-implementation/docs/compact-island-environment-art-brief.md#whole-shore-composition-contract-review67-not-implemented)

**Review66 — modest northern-shoulder gain; whole-shore quality remains UNQUALIFIED.**
Matched native views show a local improvement, but the whole pond still reads
as a continuous brown oval beside bright, uniform turf. Retain this as an
**unqualified data-only direction, not a fix or default promotion**. The initial
28.14/28.10 inner-height proposal was rejected before geometry; both were
corrected to **28.08**, without relaxing guards. Earlier failures remain recorded.

**Four tests pass, with one historical skip.** Focused lint and the **704-root
test-inclusive typecheck** pass with zero diagnostics; no rebuilds.
Sampled canonical/indexed error
is at most **1.262cm against the unchanged 2cm gate**. The access proof retains
**27 protected tiles and 1,300 completed routes**; bounded partial-path replanning
warnings remain, so this is not a navigation-latency claim.

Baseline/candidate rails fully decode without null-decoder warnings:
**324 / 319 frames**, spanning **11.967 / 11.966s**, with **58 / 59 advancing
actual-render samples**. Recorder/HUD and exact camera return pass.
Each run preserves its own **312 / 328 bank anchors** on return; these are
undeformed anchors, not complete blade-contact or temporal-quality proof.
Both launchers exit **0**, browsers close and five ports clear. All **22 pins
within each run** remain stable; **21 common pins match**, excluding only
the deliberately different world-areas manifest. Prior shutdown failures are
not thereby fixed.

Exploratory cost observes **191 draws each**, **1,555,461 → 1,557,675 triangles**
and observed-pass-union p95 **14.614528 → 14.548992ms**. Background load and changed
geometry prevent a causal performance win; this is not full-GPU-frame or
60fps qualification.

Next: one **whole-shore** composition using coherent authoritative bank geometry
and matched groundcover while protecting access—not another isolated height
threshold adjustment. No AAA, repetition, temporal or performance gate closes:
the shared checklist remains **3 checked / 8 open**.
[Review66 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review66-UNQUALIFIED/README.md) · [Actual northern bank](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review66-UNQUALIFIED/candidate/candidate-wide.png) · [Whole-pond overview](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review66-UNQUALIFIED/candidate/candidate-pond.png) · [Native rail](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review66-UNQUALIFIED/candidate/bank-motion.webm) · [Media receipt](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review66-UNQUALIFIED/media-verification.json)

**Review65 — material isolation complete; visual and performance quality remain UNQUALIFIED.**
Nineteen actual native material-output images separate coverage, diffuse input,
shading normals and the existing compensated stochastic dirt layer. There is
**no convincing periodic grid in the inspected isolated-dirt views**; this does
not close the original repetition gate. The dominant uniform bank collar and
groundcover transition remain unresolved. No production code, art or default
was changed. These images do not justify adding an expensive histogram branch.

All **seven native textures have 11 mip levels**, with actual **16x sampler-cache**
evidence. This verifies installed sampling state, not image quality at every
distance or measured performance. All **27 selected pins and two helpers** remain
unchanged.

Both 12-second rails fully decode without null-decoder warnings: the initial
bank rail has **304 frames / 11.957s**, and corrected grazing rail **314 frames /
11.935s**, with **59 advancing actual-render samples each**. Recorder/HUD cleanup
and exact original-versus-return camera position, quaternion and FOV pass.
The first near rail is **dry-turf-framing limited**. Three decoded grazing
stills are useful coverage, **not full temporal, shimmer or mip acceptance**.

Native launcher shutdown exits **1** after game-client SIGKILL and an `EPERM`
observation. Browser/camera are restored and closed, all five ports are clear,
and the exact owned disposable database/volume is removed. This is **not a
clean lifecycle pass**; the failure and earlier evidence are retained.

Next: one coherent bank-shape and matched groundcover trial with protected
access, followed by the same near/grazing/distance evidence. All acceptance
gates remain unchanged: **3 checked / 8 open**, including full-world quality.
[Review65 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-texture-review65-UNQUALIFIED/README.md) · [Actual grazing bank](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-texture-review65-UNQUALIFIED/baseline/bank-grazing-original.png) · [Corrected native rail](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-texture-review65-UNQUALIFIED/baseline/grazing-distance-motion.webm) · [Media verification](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-texture-review65-UNQUALIFIED/baseline/media-verification.json)

**Review64 — clearer reed leaves, but still UNQUALIFIED development art.**
Six native stills and two rails show improved leaf readability, but stiff, flat,
repeated spear tufts remain. This is **not preferred final art or a default**.
The 15 reeds remain one batch: **964 vs 972 triangles**, exact material and
18-color palette; whole dressing stays **64 instances / six batches**.
Candidate/baseline **2,478 / 2,598 lowest-root probes** are below retained ground;
this is not proof of every crown contact or GPU-deformed vertex.

Both rails fully decode: baseline/candidate **352 / 356 frames**, with **61
advancing render samples each**. PNG colorspace warnings remain recorded.
Policy tests pass **7 Node + 7 Bun**; **34 distinct validator cases** have
passing evidence across corrected runs, **not one fully green full-suite run**.
The initial phase-.61 failure, first candidate hash rejection and test history
are preserved. Within attempt02, all **27 + 23 + 8 selected pins** stay stable.

Baseline/candidate cost windows observe **599 / 590 frames**, observed-pass
union p95 **14.41792 / 14.09024ms**, client interval p95 **18.7 / 23.1ms**
(max **26.7 / 105.9ms**) and **189 / 191 draws**. These are **not a controlled
win, complete GPU-frame measurement or 60fps approval**.
Baseline shutdown exits **1** after client SIGKILL and one `EPERM`; candidate
exits **0**. Cameras/browser, owned disposable databases/volumes and five ports
are cleaned up; the baseline failure remains explicit.

Next: bounded source-versus-stochastic/mip texture isolation, not another
broad parameter pass. Original grid recurrence is not proven by latest pond
images; the continuous brown collar and water remain separate open gates.
Exactly **3 checked / 8 open**; prior history and checklist lines are unchanged.
[Review64 receipts](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review64-UNQUALIFIED/README.md) · [Actual near view](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review64-UNQUALIFIED/attempt02/candidate/candidate-near.png) · [Native rail](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review64-UNQUALIFIED/attempt02/candidate/reed-motion.webm) · [Next texture isolation](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review64-UNQUALIFIED/next-texture-isolation.md)

**Review63 — northern-bank composition and reflection correctness improve; still UNQUALIFIED.**
Three matched native views show a local planting improvement, not AAA or
whole-shore acceptance. The actual census finds **64 instances / six batches**
and **2,598 lowest-central-root probes** below retained terrain; this does not
prove every leaf/crown contact. Thin lime reeds, dark foliage, uniform turf,
the brown collar and repeated shore motifs remain. No default is promoted.

**79 tests pass across nine focused files**, with one historical-profile skip.
Ordinary shared types, normal shared/server builds and the **712-root /
nine-test-file** inclusive typecheck pass with zero diagnostics. The initial
nine test-typing failures and earlier packaging/fixture failures are preserved.
The normal 27 pins remain stable; **20/21 extra pins** match because the root
diagnostic's minimum-support calculation was corrected and its original retained.

Actual reflection diagnostics verify pond plane **27.8**, camera **34 → 21.6**
rather than baseline **−2**, with sea level still **16** and one **640×360**
target. Disabled windows record zero callbacks; enabled/re-enabled windows have
**35/26 distinct frame/render-camera keys**, at most one callback per observed
frame. Reflection preference, instrumentation and strict readiness are restored.

The 12-second candidate rail has **357 decoded frames**, increasing PTS
**0–11.972s**, and **60 advancing render samples**; recorder/tracks/hooks,
camera and HUD restore. This is not temporal/mip acceptance. Candidate-only
exploratory cost records **592 frames**: observed-pass union p95 **14.7456ms**,
client interval p95 **24.3ms** (max **102.1ms**), **191 draws / 1,555,461 triangles**.
Background load and no review63 baseline cost prevent a controlled comparison,
full-GPU-frame or 60fps qualification.

**Both launchers exit 1:** baseline requires client SIGKILL; its post-reflection
admission failure is consistent with insufficient profile-settling time, but no
exact failed snapshot was saved. Candidate passes final admission; shutdown needs client
SIGKILL and has one `EPERM` group-inspection error. No groups remain; camera/browser,
exact disposable databases/volumes and all five ports are cleaned up. Neither
whole run is green.

Next finish a fuller reed/groundcover silhouette within the existing instance
budget and integrate its substrate through shared material/grass ownership;
not more density or ring-threshold tuning. Water subdivision/lighting-normal
coherence, original repetition and all other quality gates remain open:
exactly **3 checked / 8 open**. Review62's rejected art and all history remain.
[Review63 verdict and receipts](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review63-UNQUALIFIED/README.md) · [Actual northern bank](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review63-UNQUALIFIED/candidate/candidate-wide.png) · [Whole pond](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review63-UNQUALIFIED/candidate/candidate-pond.png) · [Native rail](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review63-UNQUALIFIED/candidate/northern-habitat-motion.webm)

**Review62 — variation improved, but the mown oval is rejected as preferred art.**
Four actual native stills show more bank/turf variation, but shorter grass
exposes an artificial mown oval. Reject these parameters as the preferred pond
appearance. The shared CPU/TSL margin, root-color/support and pre-grounding
clump-scale implementation remains within the existing `shore-contact-v1`
**opt-in only**; defaults are unchanged. This is not AAA or whole-world approval.

Verification passes **608 tests across five files**: 136 material, 12 palette,
396 selector and 64 worker/manager tests. Ordinary shared types, the explicit
**708-root test-inclusive** typecheck and normal shared/server builds pass.
Seven maps / **33 surface texture reads**, **17 rocks / 56 blocked cells** and
all **27 selected pins within each run** remain unchanged. No review62 motion
or GPU-cost trial was taken: art rejection deliberately stopped that work.
There is **no performance qualification** or claimed win from fewer/shorter clumps.

Baseline launcher exited **0**. Candidate exited **1** because one game-client
process-group inspection returned `EPERM` during shutdown; the later zombie
snapshot does not establish its cause. Browser/camera, exact disposable
databases/volumes and all five owned ports were cleaned up. Preserve that
failure, earlier failures and the unresolved full-client-packaging failure.

The generated pond paintover and its prompt are a **design target only**, not
in-game evidence or approval. Next coordinate natural bank shape, grounded rock
groups, vegetation and water. Source audit also identifies an incorrect pond
reflection plane (**16 vs 27.8 when reflection is enabled**), a single-center-fan
under-wave mesh and disconnected lighting normals; these are **not yet fixed**.
Original repetition, motion/mips, water, path/grass and full-world quality gates
remain exactly **3 checked / 8 open**; all earlier evidence stays intact.
[Review62 verdict and receipts](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review62-UNQUALIFIED/README.md) · [Actual baseline](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review62-UNQUALIFIED/baseline/baseline-pond.png) · [Rejected actual candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review62-UNQUALIFIED/candidate/candidate-pond.png) · [Concept only](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review62-UNQUALIFIED/pond-art-target-CONCEPT.png) · [Concept prompt](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review62-UNQUALIFIED/CONCEPT-PROMPT.md)

**Review61 — pond transition slightly crisper; not a substantial or preferred art result.**
The explicit `pondBlend=shore-contact-v1` trial narrows soil/turf coverage
around its existing midpoint, with shared CPU/TSL coverage and retained legacy
cliff suppression, wetness and relief/contact locality. Six actual native
stills were independently compared: the edge is slightly crisper, but the
continuous dark pond outline, painted transition and uniform turf remain.
Keep the experiment **opt-in only**, not an accepted pond appearance; defaults
are unchanged. No obvious square grid was visible; that does not close the
original repetition issue or motion/mip acceptance.

Verification passes **601 tests in five files**, shared types/builds, server
build and the explicit **708-root test-inclusive** typecheck. Seven maps /
**33 surface texture reads** remain unchanged; all **25 sampled terrain points**
match baseline/candidate exactly, and **27 selected candidate pins** stayed
stable. These bounded checks are not whole-world or visual acceptance.

The requested 12-second native candidate rail was recorded; temporal quality
remains open. Observed-pass union p95 is **18.67776ms across 518 baseline frames**
versus **18.546688ms across 523 candidate frames**. Two grass cells retained
different LODs/counts and camera histories differ, so this is **not a controlled
performance win**, full GPU-frame measurement or 60fps qualification.

Both launchers **exited 1** because their clients required SIGKILL; inspection
errors were zero. Chrome closed, exact disposable test databases/volumes were
removed and all five owned ports cleared, but the shutdown failures remain
open. The previous full-client-packaging failure is also unresolved.
Next address the whole-bank material/vegetation relationship and continuous
dark outline, not more small endpoint tuning. Whole-pond, repetition, mip,
motion, dry-ground, water, path/grass and full-world acceptance remain open:
exactly **3 checked / 8 open**, with all earlier evidence preserved.
[Review61 verdict and receipts](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review61-UNQUALIFIED/README.md) · [Close baseline](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review61-UNQUALIFIED/baseline/baseline-wide.png) · [Close candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review61-UNQUALIFIED/candidate/candidate-wide.png) · [Grazing candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review61-UNQUALIFIED/candidate/candidate-near.png) · [Whole-pond candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review61-UNQUALIFIED/candidate/candidate-pond.png) · [Native rail](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review61-UNQUALIFIED/candidate/candidate-motion.webm)

**Review60 — coastal boundary visibly improved; opt-in only, texture gates remain open.**
The explicit `coastBlend=cavity-v1` candidate reuses source-aligned rock AO
(cavity, not height) with conserved shared PBR weights and no added texture
reads. All six matched native stills and actual bound shaders were inspected;
the seven map hashes match and source graphs retain **33 texture-sample nodes**.
The boundary is narrower and less airbrushed, with clearer rock detail, but
bright green streaks/speckles still look painted, turf remains uniform and rock
fractures repeat. Retain this directional improvement **opt-in only**: no
default promotion or AAA acceptance. The excluded original pond looks unchanged;
one close strip without an obvious square grid does not close that issue.

Material tests pass **127/127**, selector tests **379/379**; ordinary and
test-inclusive types and shared/server builds pass. Both runs retain the
existing **17 rocks / 56 blocked cells** in all three strict view censuses.
Twenty-five selected pins stayed unchanged within each run. Review57 full
client packaging and earlier unrelated failures remain open.

Single instrumented windows have equal captured terrain/grass descriptors and
**465 draws / 3,958,245 triangles**: observed-pass union p95 is **29.16352ms baseline /
29.4912ms candidate**. These are not complete GPU frame times, a causal
shader-cost result or 60fps qualification. The candidate rail has **178 decoded
frames**, strictly increasing PTS **0–5.848s** and three clean extractions;
sampled frames do not qualify temporal/mip behavior.

Candidate shutdown remains **exit 1**: the client exceeded SIGTERM grace and a
group probe returned `EPERM`; the cause is unresolved. Browser, camera, test
processes, exact disposable database/volume and all five owned ports were
cleaned up, but this is not a wholly green native run. Next verify the original
pond near/grazing/moving views, shared path/grass ownership, root-color contact
and water wave/detail-normal coherence. Exactly **3 checked / 8 open** gates
and all historical evidence remain intact.
[Review60 verdict and receipts](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review60-UNQUALIFIED/README.md) · [Near baseline](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review60-UNQUALIFIED/baseline/baseline-near.png) · [Near candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review60-UNQUALIFIED/candidate/candidate-near.png) · [Original pond candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review60-UNQUALIFIED/candidate/candidate-pond.png) · [Moving-rail evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review60-UNQUALIFIED/candidate/candidate-near-motion.webm) · [Paired observations](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review60-UNQUALIFIED/paired-native-summary.json)

**Review59 — world-owned coastal integration passes; the rock arrangement is rejected as art.**
The explicit opt-in `compact-preparation-coastal-rocks-v2` production/runtime
path is implemented, with canonical grounding and the existing collision,
navigation, grass-footprint and instanced-LOD owners. Six strict actual-game
censuses pass: baseline **17 rocks / 56 blocked cells**, candidate **19 / 72**.
The original 17 native transforms and sampled support values are exactly
unchanged, including **zero Y delta**. This verifies reusable integration,
not natural composition or full navigation/gameplay acceptance.

Matched wide/near images still show small isolated, contrasting props on uniform
green turf; they do not break up the patterned cliff face or its soft material
edge. The original pond is visually unchanged. Reject this arrangement as the
shoreline solution; no candidate manifest, asset or default is promoted.
Next improve the actual material and edge transitions in matched coast and pond
views, not further isolated placement guesses. All whole-world texture gates
remain open: exactly **3 checked / 8 open**.

The historical-default suites pass **30 tests with 1 explicit candidate skip**;
the separate exact-review52 candidate run passes **2 tests, 5 filtered**.
The broader exact-review52 run's **27 passed / 4 failed** remains preserved and
open; no collision tolerance or historical oracle was weakened. Shared/server
builds, ordinary and test-inclusive types pass. Review57 full client packaging
remains open. These results do not qualify the current world as fully green.

The candidate's moving-rail recording has **327 decoded frames**, but both full
null-output decodes retain repeated-DTS muxer warnings. Sampled frames and render
counts are not temporal or performance acceptance; **no GPU timing was taken**.
All 19 selected pins stayed unchanged within each run. Both owned browsers,
processes and disposable test databases were cleaned up, and all five test
ports cleared. Earlier evidence and failures below remain intact.
[Review59 verdict and receipts](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review59-UNQUALIFIED/README.md) · [Near baseline](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review59-UNQUALIFIED/baseline/baseline-near.png) · [Near candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review59-UNQUALIFIED/candidate/candidate-near.png) · [Original pond candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review59-UNQUALIFIED/candidate/candidate-pond.png) · [Moving-rail evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review59-UNQUALIFIED/candidate/candidate-near-motion.webm)

**Review58 — all three bounded cliff fits rejected; world textures still UNQUALIFIED.**
The closed segment was not installed. Burying its unfinished shell/caps leaves
too little useful facade; surviving fragments contact the declared CPU movement
envelope. That is not actual PhysX/navigation proof or proof every redesigned
asset/site fails. Stop further shell-burial guesses: the next geometry task
needs finished natural return/cap surfaces or a deliberately redesigned,
jointly qualified canonical backing landform.

Actual current-game captures show the unchanged world in three control views
and a recorded pond camera rail with a six-second requested recording window,
not a cliff-candidate comparison. No obvious square dirt grid appears in the
inspected pond frames, but the broad soft bank transition, uniform turf and
recognizable coastal rock motifs remain. Sampled frames and advancing render
counts do not qualify temporal stability, distance/mips or performance.

Boot took **48.82 s**; grass readiness from the coast-wide, coast-near and pond
camera cuts took **4.905 / 0.503 / 6.462 s**. These are diagnostic waits, not
gameplay acceptance. Twelve selected pins stayed unchanged. Existing cow-404
placeholder logs remain; no other client-console warning/error or page error
was captured.
Recording hooks were restored, owned browser/server/REPL were closed, all five
owned ports cleared, and the sole disposable test database was cleaned up.

No production code/asset/default was promoted and no new review58 suite total
is claimed. Review57 full client packaging remains open. Original pond dirt and
all whole-world texture gates remain open: exactly **3 checked / 8 open**,
with all earlier evidence preserved.
[Review58 native evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review58-UNQUALIFIED/README.md) · [Corrected rejected placement study](/Users/lucid/Documents/hyperia/asset-studio/coastal-cliff-segment58-placement-UNQUALIFIED/README.md)

**Review57 — physical-material loader fidelity repaired; cliff art still UNQUALIFIED.**
The actual ModelCache path flattened authored Physical materials into Standard
materials. It now uses the existing native PBR-copy helper. Final processed-cache
schema **7 / policy v4** retains the existing database schema and rejects old
flattened rows by exact policy. Physical materials deliberately bypass processed
caching instead of silently losing their properties. The unnecessary schema-8
upgrade was withdrawn because an old open tab could block it; pre-existing
blocked-upgrade lifecycle limitations remain open. Final schema-7/policy-v4
verification passes **98/98 tests across six files**, normal shared type checking
and build, server build, ESLint and Prettier. Earlier native03/revision evidence
remains preserved in the linked review.

Isolated final native04 compares the original loader with actual ModelCache output
for the frozen05 full-cliff source on non-fallback Apple Metal WebGPU:
three views at **960x540, DPR1**, maximum reported linear pixel difference
**0.0001220703125**, and zero page, console, request or GPU errors. Owned browser,
server and diagnostic resources are closed; source/material/geometry pins remain
unchanged. An actual second IndexedDB connection stayed open on schema 7 during
loading with zero version-change events. This qualifies same-version loading,
not future upgrades or persistent-warm behavior. Native04 matches native03's
reported pixel deltas; neither is full-game art or performance approval.

Full client packaging remains open: the standard asset-copy step failed with
`EDEADLK` on the preserved dataless backup
`public/textures/noise3.jpg.dataless-backup-20260914-client-batch01`.
The file was not hydrated or deleted. Separate code-only compilation passes with
public copying omitted; this is not a deployable-package or public-asset pass.
Full public-asset packaging remains failed/open, without bypass acceptance.

The separate, uninstalled **14 m cropped-front, closed cliff segment** has three LODs at
**15,016 / 4,764 / 1,384 triangles** and passes structural checks. The front
retains detail, but caps/rear remain visibly jagged and require fitting/burial.
The **7,318 / 861 / 110 overlap candidates** are not triangle-intersection
proof. Modular cliff reuse is a production-art direction, not automatic visual
acceptance; the [original artist breakdown](https://gamesartist.co.uk/present-moment-farm/)
describes reusable cliff forms with smaller supporting rocks.

Full-game cold loading, persistent-cache behavior, terrain/grass contact,
collision/navigation, moving-distance LODs and measured cost remain open.
The original bare-pond dirt and every whole-world texture gate remain open.
Exactly **3 checked / 8 open** gates and all review56/earlier evidence are retained;
no asset/default is promoted and no commit or push follows.
[Review57 material-fidelity evidence](/Users/lucid/Documents/hyperia/asset-studio/model-material-review57-UNQUALIFIED/README.md) · [Review57 uninstalled cliff-segment evidence](/Users/lucid/Documents/hyperia/asset-studio/coastal-cliff-segment57-UNQUALIFIED/README.md)

**Review56 — Seaside Rock rejected as a full replacement; UNQUALIFIED.**
Paired native coastal wide/near and original bare-pond views, plus both
12-second coastal clips, complete the bounded source audition. Seaside Rock
at its verified 2 m width reduces recognizable fracture motifs compared with
Rock Face03 at 2.7 m, but reads as dark fine-grained earth with weak medium-scale
rock form. The soft bright-green fringe persists. This does not prove a normal
bug or that geometry alone is responsible. The original bare-pond still has no
obvious square grid in these views; its full texture-quality gate remains open.
`coastBlend` was omitted on both sides; no distribution experiment is promoted.

The first candidate boot failed strict PBR hash admission: `ASSETS_DIR` selected
manifests, while `/game-assets` preferred `WORLD/assets`. Correcting the isolated
harness's `WORLD` selection admitted the intended assets; all seven actual HTTP
and native texture hashes then matched. The failed boot is preserved, and no
asset-admission check was weakened.

All three temporary production calibration files were restored to their exact
original SHAs. Normal shared type checking and shared/server builds exited 0;
all eight rebuilt artifacts are byte-identical to baseline. Owned runtimes are
cleaned up and all five owned ports are clear. Native GPU cost was deliberately
not measured after art rejection, so no speedup or performance approval follows.
Restored-source verification is complete: the guarded Node run passed all
**521/521 tests across seven files**, packed-map tests passed **9/9**, and the
installed packer CLI `--check` exited 0, confirming six RGBA8 maps with the
original Grass004, Rock Face03 and Poly Haven Dirt sources. The incompatible
initial direct-Bun Vitest run (**513 passed / 8 failed**) is retained separately;
no code, test or acceptance criterion was weakened. These are source/packing
checks, not visual or performance approval.
No default is promoted, no quality gate is closed, and no commit or push follows.
Exactly **3 checked / 8 open** gates and all prior evidence remain intact.

[Review56 verdict and evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review56-UNQUALIFIED/README.md) · [Near baseline](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review56-UNQUALIFIED/baseline-near.png) · [Near candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review56-UNQUALIFIED/candidate-near.png) · [Original pond baseline](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review56-UNQUALIFIED/baseline-pond.png) · [Original pond candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review56-UNQUALIFIED/candidate-pond.png)

**Current verdict — review55 changes coastal classification, but is not art accepted; UNQUALIFIED.**
Matched actual wide/near captures show a clear effect from the explicit
`coastBlend=distribution-v1` candidate, unlike review54's negligible detail-mask
payoff. Main and independent reviews still reject the result as finished:
a dark continuous painted-looking soil collar, an overly bare lobe, bright
green fringe and brown stems remain. Recognizable rock motifs are unchanged.
The historical review54 rejection and all earlier failures below remain intact.

The candidate shares one broad material-distribution expression across terrain
PBR weights, analytical grass support and mean root color. It only reassigns
available turf to soil/rock, retains the original seeded acceptance/rotation
stream before thinning, and protects roads and the full admitted pond bank.
Geometry, source textures, projection, wetness and default selection stay fixed;
no additional texture reads or generic density reduction are used. This is an
opt-in experiment, not an accepted world-material replacement.

All **540 matched native sample points** retain exactly equal ground heights,
indexed shading slopes and sampled terrain resolutions. **153 low-shore and
8 western controls** retain exactly equal sampled native CPU root RGB and
placement values. These witnesses do not prove pixel-level PBR/root-color
parity, every blade's ecology, or unchanged output everywhere: analytical and
indexed normals differ. Final combined verification is recorded separately;
no unconfirmed final test total is asserted here.

Original bare-pond dirt, coastal soil/rock, paths, grass, water, texture scale,
near → gameplay → stream distance → return, and frame/loading/memory cost
remain open. No performance or AAA approval, default promotion, commit or push
follows. All historical failures and exactly **3 checked / 8 open** texture
gates are retained. Next resolve the visible broad soil/turf/rock composition
and root contact, then complete whole-world and moving-distance coverage;
do not hide the remaining bank defect with foliage.

[Review55 verdict and evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review55-UNQUALIFIED/README.md) · [Wide control](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review55-UNQUALIFIED/control-coastal-wide.png) · [Wide candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review55-UNQUALIFIED/candidate-coastal-wide.png) · [Near control](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review55-UNQUALIFIED/control-coastal-near.png) · [Near candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review55-UNQUALIFIED/candidate-coastal-near.png)

The user's quality bar applies to every world material, not just the dirt bank.
Keep this ahead of further decorative placement. Source tests or attractive
wide shots cannot close a close-up texture defect.

- [ ] Remove recognizable dirt/shore repeat motifs and patch-grid artifacts
  without blurring soil detail or hiding it behind vegetation.
- [ ] Review grass, paths, coastal soil, cliffs/rocks and water for consistent
  physical texture scale, visible repeats, seams and projection stretching.
- [ ] Preserve albedo/roughness/normal/AO/height alignment, correct color-space
  handling and coherent dry/wet response; dry ground must not read as polished.
- [ ] Replace soft painted-looking material borders with convincing ground
  transitions while preserving open traversal and shared grass support.
- [ ] Validate close, overhead and grazing views in motion, including near →
  gameplay → stream distance → return: no texture swimming, objectionable
  shimmer, mip color shifts or abrupt detail transitions.
- [ ] Compare actual GPU/frame/loading/memory cost at unchanged resolution and
  population before retaining a quality change. No automatic default promotion.

The earlier September19 texture capture observed all seven maps at16x, but
**review47 disproved reliable inheritance**: a later boot had seven loaded maps
at1x despite `ClientGraphics.maxAnisotropy === 16`. Texture construction can
precede the global default update. The strict quality gate rejected that run;
it was not timed or manually upgraded for comparison. Compact texture setup
now explicitly requests the intended16x for placeholders and decoded maps.
The earlier proposed4x downgrade remains withdrawn. Stochastic dirt sampling
remains a partial improvement, not final acceptance.

Review45 adds runtime filtering visibility and87 passing material tests, not
a visual fix. The close coastal image also exposes repeated rock features and
a soft green material border. No new sampler or shader was adopted.
[Texture review45 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-texture-review45-UNQUALIFIED/README.md)

Review46 adds an explicit opt-in `rockProjection=stochastic-v1` material branch;
**297 focused tests passed**. The same seven 1024x1024 maps and native 16x
filtering retain original physical scale and aligned PBR channels; terrain,
navigation and absent/default mode remain unchanged. With dirt and height
selected, static surface reads increase **27 -> 33**, plus ALU work. These
structural counts are not measured GPU approval.

**Native46 FAILED / UNQUALIFIED.** Intended matched `candidate-bank.png`
shows **APPLICATION BOOT TIMEOUT**, not an approved terrain comparison. The
candidate startup camera was installed before grass/sky owners were ready;
correct harness admission before drawing causal conclusions. Scene readiness
later became true, but global readiness remained false after the boot timeout.
Do not weaken, hide or rewrite the readiness gate or its failed evidence.

The control's 30s grass-cut check failed with 24 chunks still running. Candidate
focused cadence was 49.0 ms versus control 20.3 ms, but submitted triangles differed
(2,812,935 versus 2,630,259), preventing isolation of shader cost. **All GPU-cost
results are rejected** because resumed render passes reused timestamp slots;
no visual-improvement or performance acceptance follows.

Original pond-dirt repetition and the rock-bank candidate remain **separate
open gates**. Next bounded steps, without changing their acceptance criteria:

- [x] Correct diagnostic boot/grass/sky admission before camera installation;
  review47 now has actual naturally matched control/candidate bank captures.
- [x] Correct physical-pass timestamp ownership; schema2 validates real native
  captures and rejects corrupted or incomplete data. Review46 remains rejected.
- [ ] Complete separate dirt-pond and rock-bank near/mid/grazing comparisons
  plus repeatable motion, preserving detail, material alignment and budgets.
- [x] Attribute the pond's pale rim using actual native main-camera layer/cause
  shader outputs; review48 confirms a rock band where pond-soil coverage ends.
- [ ] Refine the remaining pond rock/soil/turf transition and bank profile;
  original dirt repetition, motion/mips and performance acceptance remain open.

[Texture review46 failed evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-rock-review46-UNQUALIFIED/README.md)

**Review47: progress, still UNQUALIFIED.** Matched daylight bank images reduce
aligned rock fissures without obvious stone-detail loss. The new bare-pond view
shows no obvious square grid in that still, but reveals a continuous pale rim,
dark substrate band and abrupt turf boundary. Neither original dirt nor overall
world material quality is closed by these stills.

298/298 focused tests, shared type check and development build pass. Candidate
cotangent inputs are shared without changing all33 texture reads or the expanded
normal expression; emitted derivative/cross pairs fall14->6. The filtering race
fix also survives both rebuilt native boots with all7maps at16x. Defaults for
rock/dirt/height selection, texture resolution and geometry remain unchanged.

At matched camera/daylight/settings, rebuilt control/candidate observed GPU-pass
union medians are16.515/22.938ms (p9518.416/24.773ms); client tick medians are
18.1/24.7ms. Each submits374draws/2,605,659triangles per tick. Full-scene grass
counts differ84,513/84,519 and visible-scene triangle totals differ, so this is
not an isolated shader-cost or statistical performance approval. Do not infer an
optimization factor from the earlier53ms candidate window at a different phase.

Native query/camera/HUD owners restored and owned test resources were removed.
The launcher nevertheless reported exit1 after client SIGKILL/EPERM inspection;
retain that shutdown failure even though subsequent process/port checks are clear.
No automatic default promotion, commit or push.
[Texture review47 evidence and next gates](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-texture-review47-UNQUALIFIED/README.md)

**Review48: attribution confirmed; bank refinement still UNQUALIFIED.** Actual
native main-camera layer/cause outputs identify rock along the pale rim, with
geometric cliff coverage where pond soil ends. The pond-only `height-v1`
sediment candidate transfers existing rock weight to dry soil without changing
shared wetness, grass support, geometry, navigation or default selection.

Matched daylight baseline/candidate start phases are **0.5898986 / 0.5898721**,
with equal camera and **1280x720, DPR1, MSAA4, seven 1024x1024 maps at 16x**.
The terrain profile, 52 terrain leaves and 94 grass chunks / 84,498 clumps match.
The candidate modestly reduces the upper pale edge, but a pronounced continuous tan
ring remains; grazing stills retain a manufactured bowl-rim appearance. The
candidate layer-weight image confirms remaining rock. These are spatial stills,
not motion/shimmer evidence, and neither original dirt repetition nor AAA
material quality is accepted.

**304 focused tests**, shared types, development shared build and verified
server build pass. Both emitted shaders retain **53 `textureSample*` call
sites** (7 ordinary + 41 gradient + 5 comparison samples), with source size
126,822 -> 127,694 bytes. This is not a surface-only budget or GPU-cost result.
No performance qualification was attempted on battery. Baseline/candidate boot
times are **106.533 s / 66.308 s**, and camera-cut settling **14.425 s / 8.629 s**:
readiness completed, but this is explicitly not smoothness approval.
Cumulative grass max slices are **10.8 ms / 5.4 ms**, both above the 2 ms target;
no causal performance claim follows. Zero page exceptions do not mean a clean
console: 11 errors include missing-cow 404s and one unattributed generic 503.

The initial build-manifest rejection is retained; normal rebuilding preceded
the substantive runs. Both substantive launchers exited 0, owned browsers closed,
material/camera/HUD ownership restored, and the verified stopped disposable
database/sole-use volume were removed; source, assets and evidence remain.
No default promotion, commit or push.

Next: inspect the actual bank height/slope transect alongside final material
weights, then make one cohesive bank-profile/material pass. Do not substitute
blind threshold nudges, more texture samples or decorative coverage for that
decision. Keep separate original dirt, motion and performance gates open.
[Texture review48 evidence and next gates](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review48-UNQUALIFIED/README.md)

**Review49: localized bank-shape improvement; still UNQUALIFIED.** An actual
25-point indexed-geometry/normal transect places the visible pale rim at pond
radii **7.00–7.25 m**. The earlier target **0.331 m above water was lawn**, not
the rim. A new explicit review49 overlay adds only a third shallow bank sector;
preview44, defaults and all material/shader sources stay frozen.

At matched bank poses, daylight starts at **0.58991354 / 0.58955883**, with
**1280x720, DPR1, MSAA4, post-processing off**, and the same seven
**1024x1024 / 16x** maps. Root and independent review see clear local pale-rim
removal, not whole-pond acceptance. The close view retains a soft airbrushed
soil/turf boundary, uniform lawn and a far-left pale edge. The new overview
still shows a continuous dark perimeter and regularly spaced detached rock
groups; original dirt repetition, motion/mips and full-world quality remain open.

The first candidate run passes **30/30 tests across two files**, with a further
**3/3 native-physics fixture tests** passing. The frozen preview44 regression
passes **2 tests, 1 skipped**, retaining the same routes. Forty retained-mesh,
Three.js and PhysX probes stay within the unchanged 2 cm canonical bound.
Sampled terrain leaf triangles increase **74,034 -> 74,758 (+724)** across the
same 52 leaves. These checks are not actual player-walking or GPU acceptance.
Expanded test typechecking initially found three diagnostics; fixes now pass
shared types and the explicit two-test program with zero diagnostics. Final
post-fix native candidate **3/3** and historical preview44 **2 passed / 1 skipped**
reruns pass with exactly equal navigation receipts. Native boot
**101.109 / 52.858 s** and bank-cut settling **12.950 / 8.507 s** are observations,
not a speedup claim;
no performance qualification on battery.

Baseline launcher exited 0; **candidate launcher exited 1** after game-client
SIGKILL and process-group inspection EPERM. Preserve that failure even though
owned groups/ports are now clear. Cameras restored, browsers closed, and the
verified stopped owned database/sole-use volume were removed; assets and evidence
remain. Ten cow-related 404 console errors and six warnings remain, with zero
page errors/request failures. No default promotion, commit or push. Continue
cohesive full-bank refinement, then the original dirt/rock near/mid/grazing and
motion/budget gates.
[Review49 evidence and remaining gates](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review49-UNQUALIFIED/README.md)

**Review50: modest pond-transition refinement; still UNQUALIFIED.** The explicit
`pondBlend=relief-v1` candidate requires the fine-meadow pair and
`terrainBlend=height-v1`. It uses the existing aligned relief maps on the frozen
review49 geometry; defaults, wetness, grass support and access remain unchanged.
**105 material tests and 229 runtime/profile tests pass**, as do shared and
explicit test-inclusive typechecks. The corrected test-only ES2021 failure and
the broader run's two historical **expected-v4 versus actual-v6** fixture
failures remain in the evidence; this is not a fully green repository run.

The actual native close image is valid at the matched review49 camera and
**1280x720, DPR1, MSAA4, post-processing off, seven 1024x1024 maps at 16x**.
Daylight phases are **0.58955883 / 0.58959855**. Main and independent review
agree on modest relief-breakup improvement only; the broad smooth shoreline
collar and uniform lawn remain. Boot **58.924 s** and camera settling
**9.755 s** are observations, not smoothness or performance approval.

**Motion verification did not complete.** An unexpected document reload
interrupted the motion wait and left the world absent. Immediate readmission
then failed `scene_assets_not_ready` after another reload. Five source/build
hashes stayed unchanged, but the reload cause is unproven. **No motion video or
new overview was saved.** Do not infer native stability, mip/shimmer acceptance
or a solved whole shoreline from the successful close still.

The owned browser closed, but **the launcher exited 1** after game-client
SIGKILL and process-group inspection EPERM. Retain that failure despite all five
ports **3333 / 5555 / 5556 / 9236 / 57831** being clear. The verified stopped
owned container
`4931a07c32d9f446e5320a9104fac0d3a363f5422623b7fb1af803e522694a03`
and sole-use volume `hyperia-terrain-pond-review50-data` were removed:
disposable test state only; no source, assets or evidence were deleted.
Power became AC only after cleanup, which does not retroactively qualify
performance.

Next prioritize **whole-pond composition, overview first**, using authoritative
bank geometry, actual asset contacts and habitat layout, not another tiny shader
gain. Original dirt repetition, broader material coherence, motion/mips and
power-stable GPU/frame/loading/memory qualification remain open. No default
promotion, commit or push.
[Review50 evidence and remaining gates](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review50-UNQUALIFIED/README.md)

**Review51: bounded native motion recovered; still UNQUALIFIED.** Production
sources/builds remain unchanged from review50; all five recorded hashes match.
Native Chrome/Metal retains **1280x720, DPR1, MSAA4, post-processing off, seven
1024x1024 maps at 16x**. Boot takes **59.220 s**. Across **15 m 15.222 s** of
observation there is one initial document request, no subsequent document reload
or crash, and HMR remains connected. This does **not** explain or fix review50's
unproven reload cause; its failed evidence remains intact.

The first recording attempt failed because `info.frame` advances before the
actual graphics render. A real **94-call probe** demonstrated that recorder
assumption. The corrected artifact-only recorder requires cumulative
`render.calls` to advance within the actual call and a distinct `info.frame`.
Its **12 s native clip is 11,719,153 bytes**, with **350 decoded frames spanning
0–11.855 s** and **60 distinct world/render/camera poses**, each with actual
render-call advancement and unchanged settings. Recorder-hook, tracks, RAF and
camera restoration are verified. This is recovered visual evidence, not a game
FPS, GPU-cost or long-duration stability pass.

The overview phase **0.58981292** matches review49's **0.58986587** closely.
Independent review finds the overview near-identical: the broad flat collar and
uniform lawn remain. Decoded frames **01 / 06 / 12** show no obvious seam,
square grid or stretching, but do not establish shimmer/mip acceptance or close
the original dirt-repeat gate.

The owned browser closed and camera/16x settings were restored. The launcher
exited **0**, with no forced process-group cleanup; ports
**3333 / 5555 / 5556 / 9236 / 57831** are clear. The verified stopped exact owned
container and sole-use volume `hyperia-terrain-pond-review51-data` were removed:
disposable test state only, with source, assets and evidence preserved. There
are **five cow-404 console errors, zero page exceptions and zero request
failures**. AC power was present throughout, but no GPU/FPS acceptance ran.

The next **whole-pond geometry/contact/layout pass remains a proposal, not an
implementation**. Start overview-first, preserve authoritative terrain and
worker/grass/contact agreement, unchanged water coverage and open fishing
access; do not substitute another small shader adjustment. Original texture,
motion/mip, loading/memory and representative performance gates remain open.
No production-code change, default promotion, commit or push.
[Review51 evidence and proposed next pass](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review51-UNQUALIFIED/README.md) · [Native motion clip](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review51-UNQUALIFIED/candidate-bank-motion.webm)

**Review52 first native attempt: FAILED / UNQUALIFIED; retained history.**
The shared paired western/northern bank profile, six explicit rock X/Z changes
and existing reed-group relocation now have **137 related CPU tests**, passing
builds and zero final test-inclusive typing diagnostics. The original native
geometry/burial failures and wrong-manifest geometry-selection run remain
retained. Corrected terrain adds **4,699 vertices / 9,346 triangles** across two
tested leaves: 8,505 new-shoulder probes peak at **2.73066 mm**, while 361 broader
probes including the unchanged southern control peak at **1.26170 cm**, below
the unchanged 2 cm gate. Actual fixture owners retain **17 rock actors,
32 dressing instances, 69 subjects, 293 approaches, 27 protected southern tiles,
1,300 routes / 105,049 edges, 48 trees and 5 fishing resources**. These are
bounded technical results, not rendered contact, live walking or art acceptance.

Actual headful Chrome/Metal/WebGPU boot passed in **68.742677 s**, retaining
**1280x720, DPR1, MSAA4, post-processing off, seven 1024x1024 maps at 16x**.
The overview camera cut failed after **3.609 s**: grass cell
`gcell_v1_13_11` / node43, an LOD0 swap at X325–350/Z275–300, exhausted the
unchanged **1,000,000 grounding-work** budget. It recorded **114.8 ms active**
against 250 ms and **670,766 resumptions** against 1,000,000. These distinct
counters must not be conflated. This is a deterministic work failure, not a
battery-speed timeout. No grass cap was raised; density, render quality,
terrain detail and texture budgets were not reduced.

**No qualified overview or motion was captured.** `failed-overview-grass.png`
contains HUD and unmatched daylight and is failure evidence, not an art A/B.
A later overly broad diagnostic attempted to return the full `ticket.work`
object; `page.evaluate` reported Target crashed, with the page crash recorded
at **13:51:37 UTC**. Causal attribution is unproven; do not repeat full-work-object
serialization. There are **6 console errors (5 cow-related, 1 grass), zero page
exceptions, one crash and one initial document request/no reload**. Source/build
pins stayed unchanged during the run. CPU/build passes do not override this
native failure or establish GPU/frame performance.

The owned browser closed. The launcher exited **1** because residual game-client
shutdown required SIGKILL; **inspectionErrorCount is 0, with no EPERM this run**.
All five ports **3333 / 5555 / 5556 / 9236 / 57831** are clear. The verified stopped
exact owned container
`18a07de40aca7194838ae2bbb276b87dd4170904b292870dff7a414152c8a478`
and sole-use volume `hyperia-terrain-pond-review52-data` were removed:
disposable test database only, with source, assets and evidence preserved.

The next step at that checkpoint was to fix **deterministic grass grounding work**
under the unchanged caps and quality settings, then repeat the matched native
overview/contact/motion review. Loading/memory, real traversal and stable-power
GPU/frame acceptance remain open. The source goal remains active; no default
promotion, commit or push.
[Review52 failed native evidence and technical scope](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/README.md)

**Review52 native retry: recovered evidence, still UNQUALIFIED.** The frozen
grass correction preserves exact old-oracle outputs while completing all
1,162 clumps / 1,089 retained at **728,531 work units**, below the unchanged
1,000,000 cap. The old exhaustive accounting is 1,106,310 units, not a passing
full job. No density, terrain/texture detail or quality reductions were used.
After fresh builds, all **36 source/test/overlay pins remain stable** through the retry.

Actual Chrome/Metal/WebGPU boot takes **53.604266 s** with unchanged
**1280x720, DPR1, MSAA4, post-processing off, seven 1024x1024 maps at 16x**.
The overview cut now settles in **4.590887 s** with no grounding failure, but
cumulative maximum grass slice **5.5 ms** still exceeds the **2 ms target**.
The initial bank cut settles in **6.715139 s**. Overview and close daylight
phases are **0.58978357 / 0.58952574**. These
matched captures do not establish seamless camera transition or smoothness.

The actual **12 s VP8 canvas clip is 12,384,360 bytes**, with **60 advancing
render/camera samples**. Render hook, recorder, tracks, RAF and camera ownership
were restored. Recording completion is not motion/shimmer acceptance; no
30/60 FPS claim follows from sampled poses or the recording's nominal rate.

The overview's schema2 physical-pass probe validates **484 measured frames**;
there are **3,198 physical segments across the full capture**, including warm-up,
and **2,904 in the measured frames**. GPU-pass union p95 is **19.791872 ms**,
client tick p95 **22.30 ms**, and instrumented CPU tick p95 **10.70 ms**, at
**205 draws / 1,629,043 submitted triangles** per measured tick. This is a
bounded overview sample, not matched old/new cost isolation or 60 FPS approval.
Untimed work, copies, queue idle and presentation are outside the union; observer
overhead is not subtracted. Probe ownership and resources restored successfully.

Current native residency records **504,728 bytes** of edge-index metadata across
**3 indexed surfaces / 52 installed chunks**. JS used heap is **2.266 GB at one
point**, not a trend, leak test or whole GPU/CPU memory budget. The two-leaf CPU
index cost and the initial geometry expansion remain recorded separately.

Main and independent art review find only modest northern-shoulder improvement:
the broad oval dark collar and uniform turf persist. Next use the existing
elevation/slope/relief systems to inspect the pond wetness contour, which applies
to the **whole blended material**, and make a source-informed bank/material
composition pass. This is not another generic anti-tiling adjustment, nor a
proven attribution that wetness alone causes the entire defect. Preserve
shared physical terrain/grass support, resource access and open traversal.

Retry events show **zero crashes, page exceptions or reloads**, one initial
document request and five deferred cow-related console errors. The browser
closed; launcher exit is **0**, with no forced groups or inspection errors.
All five owned ports are clear. The verified stopped exact retry container
`fd765629b7deb255358fc0600878527a40d6dc33296e434e3daf8701b2db3fc1`
and sole-use `hyperia-terrain-pond-review52-data` volume were removed:
disposable test database only. First-attempt grass failure, diagnostic crash
and launcher exit1 remain intact. No default promotion, commit or push.

[Review52 complete evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/README.md) · [Fresh overview](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/candidate-overview.png) · [Fresh bank](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/candidate-bank.png) · [Native clip](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/candidate-bank-motion.webm) · [Motion proof](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/candidate-bank-motion.json) · [Physical-pass proof](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/overview-physical-gpu-summary.json)

**Review53: bounded rock-contact detail, not whole-shore acceptance.** Actual
native layer/cause outputs show soil dominates the dark inner bank despite strong
raw cliff coverage; this does not justify exempting all grass from wetness.
The explicit `pondBlend=relief-contact-v1` inherits relief, then transfers only
final dry-soil weight to existing rock inside the two unequal authored contact
ribbons, constrained by original pond soil, raw geometric cliff and road priority.
Grass/coastal weights, wetness, geometry, navigation, fishing access, root colors
and density stay unchanged. Positive grass-support/contact overlap remains a
native color/contact gate; unchanged grass weight does not prove visual agreement.

**354/354 focused tests**, ordinary shared and explicit three-test types, and
fresh shared/server builds pass. All **39 source/test/overlay pins** stay stable
through builds and native review, with all eight build pins stable afterward. The selected material retains seven
1024x1024 maps at 16x and 33 surface samples; actual control/candidate normal
shaders both contain 53 `textureSample*` sites and no `textureLoad` calls.
No texture-read increase, quality reduction, default promotion, commit or push.

Actual headful Chrome/Metal/WebGPU uses **1280x720, DPR1, MSAA4, post-processing
off** on AC. Candidate boot is 63.201 s and overview cut settling 4.910 s, not smooth
startup/camera approval; cumulative maximum grass slice 11.8 ms still exceeds the
2 ms target. Matched overview/contact daylight images reveal small coarse bank
detail beneath the reeds, but do not connect the land rocks convincingly through
the green apron or remove the oval collar. The southern bare-bank image retains
a soft turf feather. The fresh coastal view retains repeated-looking cracks,
elongated mottling and a broad green fade; it is **not matched to an older A/B**.

The actual 12 s moving contact clip has 61 advancing render/camera sample receipts
and restored recorder/RAF/render-hook/camera owners. Decoded stills show no
obvious hard-mask seam, but vegetation obscures roots; complete temporal shimmer,
mips and motion acceptance remain false. **Near → gameplay → stream distance →
return**, original bare-bank dirt, coastal rock/soil, path joins and grass-root
agreement all remain unqualified.

Separate nighttime physical-pass windows cover 490 control / 483 candidate frames.
Observed GPU-union p95 is 19.791872 / 19.726336 ms and client-tick p95 is 22.5 / 23.1 ms,
but submitted triangles differ 3,398,477–3,398,509 versus 3,490,365, with separate
agent/wind state. These are not isolated material cost, a speedup or 60 FPS
acceptance. Untimed work/presentation and observer overhead remain outside those
claims. No general loading/memory or sustained performance gate is closed.

The first control's server-not-ready initialization failure and later control
launcher exit 1/SIGKILL cleanup remain preserved. Candidate events contain zero
crashes, page exceptions or reloads, one initial document and five deferred
cow-related errors, with zero request failures. Its browser is closed; camera
and render hook are restored, with all seven filters still 16x. Candidate launcher
exits 0 with no forced groups or inspection errors; all five owned ports are
clear. The verified stopped exact candidate container and sole-use
`hyperia-terrain-pond-review53-data` volume were removed: disposable test database
only; source, assets and evidence remain. The control's failed cleanup is not
overwritten by this clean candidate shutdown.

Next: attribute the **coastal shoulder** with actual final-layer/raw-cliff/normal
outputs, then cover path joins, accepted grass roots and moving texture distance
before another pond-only refinement. Keep current settings and open traversal;
do not enlarge this local mask or add foliage merely to hide remaining defects.
[Review53 scope and evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review53-UNQUALIFIED/README.md) · [Matched overview](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review53-UNQUALIFIED/candidate-overview-daylight.png) · [Close contact](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review53-UNQUALIFIED/candidate-contact-daylight.png) · [Bare bank](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review53-UNQUALIFIED/candidate-bank-daylight.png) · [Current coastal coverage](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review53-UNQUALIFIED/candidate-coastal-rock-bank-daylight.png) · [Native contact clip](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review53-UNQUALIFIED/candidate-contact-motion.webm) · [Observation ledger](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review53-UNQUALIFIED/observations.json)

**Review54: valid technique, negligible visual payoff; rejected as a fix.**
Actual native layer/cause outputs identify a rock-dominated coastal face with a
mixed grass/rock shoulder and no inland pond contribution. The normals output
is the final blended view-space material normal, not geometric normals alone.

Explicit `coastBlend=detail-v1` reuses aligned, already sampled grass height as
endpoint-preserving coverage detail, not physical rock height. All PBR channels
share the final grass/rock-branch weights; full roads and the full pond radial
region are excluded. Explicit soil weights stay fixed, but soil nested in the
coastal rock branch can change. CPU grass placement, root colors, geometry,
traversal and default selection remain unchanged. Unchanged grass ownership
does not prove root-to-ground agreement. The experiment remains opt-in only.

**388/388 focused tests**, ordinary shared and explicit test-inclusive types,
and fresh shared/server builds pass. The same seven **1024x1024 maps at 16x**
retain **33 surface reads**; both actual normal shaders contain **53
`textureSample*` sites**. No texture repacking, additional texture reads,
density/detail reduction or default promotion was used.

Matched headful Chrome/Metal/WebGPU captures use **1280x720, DPR1, MSAA4,
post-processing off** and unchanged camera/terrain. Wide daylight phases are
**0.4998439 / 0.4998224**; exact near phases are
**0.4995642024 / 0.4995562854** (control/candidate). Main and independent review
find at most subtle grain breakup: the broad airbrushed border, brown elongated
rock features and muddy grass transition remain. Approximate decoded motion
frames are not exact A/B pairs or proof of temporal stability. Both native
12-second clips restore their owned recording/camera hooks; successful
recording does not close shimmer, mip, root-contact or distance-return gates.

Physical-pass GPU-union p95 is **25.690112 / 27.19744 ms**. Submitted geometry
matches, but separate dynamic scenes and bounded windows do not isolate shader
cost or establish a regression/speedup. Neither result is 60 FPS approval; union
timing excludes presentation/untimed work and does not subtract observer cost.
Loading, memory, smooth camera cuts and sustained performance remain open.

The initial control HUD/cursor-restoration rejection, backward-phase wait
rejection and corrected test-fixture failures remain preserved. Owned native
browsers/hooks are restored or closed; launchers exit 0, all five owned ports are
clear, and verified stopped disposable database containers/sole-use volume are
removed. Only disposable test data was removed; source, assets and evidence
remain. Clean shutdown does not supersede historical failed runs.

Next: use actual spatial material/root evidence to distinguish the broad
shoulder's composition/scale problem from the rock source's interior appearance,
then choose a materially different correction rather than another mask-gain
loop. Cover paths, original bare-pond dirt, grass roots, water-edge response and
near → gameplay → stream distance → return before accepting whole-world textures.
No quality gate is newly checked; no default promotion, commit or push.
[Review54 verdict and evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/README.md) · [Wide control](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/control-coastal-daylight-recheck.png) · [Wide candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/candidate-coastal-daylight.png) · [Near control](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/control-coastal-near-daylight-recheck.png) · [Near candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/candidate-coastal-near-daylight.png) · [Control motion](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/control-coastal-motion.webm) · [Candidate motion](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/candidate-coastal-motion.webm) · [Observation ledger](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/observations.json)


## Current work — preview44 connected pond habitat; UNQUALIFIED

**World first; avatar/armor later. One arena, SOL only.** Root and independent native-image review retain preview44 over43: shoreline groups connect better and fishing cues read as water disturbances. This is a visible improvement, **not AAA or production acceptance**.

- [x] Add two unequal dry-soil contact ribbons using existing PBR maps/noise; closer 32-instance pond planting preserves five models, underwater rock guards and southern access. Physical wetness, terrain and grass eligibility remain unchanged. The broader material gate (v6 + southernMeadow) and sector-dependent dressing gate are explicitly documented.
- [x] Create an explicit unqualified overlay moving/rescaling 13 existing pond landscape rocks. Keep IDs/variants/yaw, all four workshop rocks and every other world setting unchanged. Three initially over-buried satellites were corrected explicitly; failed evidence remains. Frozen world20/defaults stay untouched.
- [x] Replace candidate blue fishing coins with a soft desaturated cue: same clickable disk, interaction metadata, depletion/respawn and existing particle pools; no new texture/mesh. **123 focused material/dressing/fishing checks pass** (104 + 19); candidate fishing cases also pass under the overlay. Shared types and shared/server builds pass.
- [x] Exact-overlay support/navigation checks: **17 actual PhysX actors/shapes, 65 occupied tiles, 1,299 support samples; 69 land resources/stations, 293 approaches, 27 preserved southern shoreline tiles; 1,300 routes / 105,049 valid edges** plus outer-pond circulation. The fixture invokes the real authoritative walkability bake; it is not server-startup or native walking proof.
- [x] Native WebGPU preview: **48/48 tree owners/proxies, 56/56 pond/service instances, 17 rock placements**, both agents and five interactive soft fishing cues. Corresponding43/44 cameras/settings match; natural daylight is very close, not identical. Both HUD captures and final awaited camera/observer cleanup succeed. Owned browser/services/disposable databases retired; source/media preserved.
- [ ] Resolve the retained native rock-ray discrepancy: **0.907 mm normal-to-surface error vs unchanged 0.244 mm bound** at a buried north-04 face. The broader exact-overlay ray suite is not green; no tolerance or placement was changed to evade it. Stream-client occupancy alone does not prove server physics.
- [ ] Fix grass preparation/LOD latency: final94 chunks /84,515 clumps, zero failed/cancelled queues, but wide/return settling **12.891 s /5.716 s**, cumulative max slice **6.3 ms >2 ms target**. Passing the diagnostic30s cap is not smoothness or performance approval; prior grounding failures stay open.
- [ ] Next art batch: natural path shoulders, continuous dark pond lip/bright lawn cuff, grass/terrain color and scale integration. Preserve open traversal and resource/fishing readability.
- [ ] Qualify motion/shimmer, real walking/interaction, repeated LOD returns, loading/memory, target-hardware frame cost and sustained gameplay/streaming before launch.

Five known cow/404 console errors remain; zero page/capture errors in44. No exhaustive GPU-cost trace, production/default promotion, commit or push. Initial failed placements, diagnostic fixtures and all older checkpoints remain visible.

[Preview44 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-preview44-UNQUALIFIED/README.md) · [Preview43 intermediate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-preview43-UNQUALIFIED/README.md) · [Current details](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)

## Prior checkpoint — preview42 physical pond contacts; UNQUALIFIED

**World first; avatar/armor later. One arena, SOL only.** The saved references remain the target. Root and independent review retain the asymmetric pond shape as a **modest improvement, not cohesive AAA art or production approval**.

- [x] Add two optional northern shelf/shoulder sectors to the existing shared physical surface. Preserve the southern fishing approach, bed, outer envelope and existing elevation-driven soil/wetness/grass owners. Frozen world20 and defaults remain unchanged; the candidate is an explicitly unqualified asset overlay.
- [x] **126 unique tests pass across seven files** (108 + 18), plus the final retained-mesh case rerun **1/1, 37 skipped**. Shared types, development shared build and ordinary server build exit 0. No full source/world/native qualification was run.
- [x] Final actual-game daylight pair shows loaded/rendered sectors, **48/48 tree owners/proxies**, **94 grass chunks / 84,389 clumps** and zero grounding queues. A warm bank→pond return settles in **482.828458 ms**; this is one preview observation, not a performance/reliability pass.
- [x] Preserve the rejected expanded 9 m refinement and its **two terminal `grounding_work` failures**. Restore the existing 7.9 m annulus without changing budgets, base grid or grass density. The corrected session has no observed grounding failures, **not a causal fix for native39's separate `active_cpu` failures**.
- [ ] Resolve the precision/performance tradeoff: restored annulus avoids **19,272 triangles**, with sampled outer-bank height error **1.2543 cm** but normal error **5.639° versus 2.207°** for the expanded annulus. Cumulative grounding slice **6.7 ms exceeds the 2 ms target**.
- [ ] Improve shore substrate/contact dressing, the continuous rim and bright turf cuff, detached plants/rocks, natural path shoulders and meadow/ground scale/color integration. Preserve free traversal and resource/fishing access.
- [ ] Qualify motion/shimmer, repeated LOD returns, walking, loading/memory, target-hardware frame cost and sustained gameplay/streaming before approval.

Use the final `bank-asymmetric-day.png` / `pond-asymmetric-day.png` pair only for current art review; both restore HUD ownership. Earlier failed-grounding/HUD and mismatched-light images remain debug evidence. Five cow/404 console errors remain, zero page errors; no exhaustive GPU-warning or cost trace was collected. Owned sessions/observers retired and the verified disposable database/sole-use volume were removed. Startup-manifest rejection, earlier failures and all prior checkpoints remain preserved; no default promotion or qualification claim.

[Preview42 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-preview42-UNQUALIFIED/README.md) · [Current details](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)

## Prior checkpoint — preview41 canopy/startup improved; UNQUALIFIED

**World first; avatar/armor later. One arena, SOL only.** Continue using the saved grass/bank images, supplied portfolios and primary Three.js examples. Root and independent review favor retaining the canopy candidate, **not AAA visual acceptance or production approval**.

- [x] Implement explicit fine-meadow upper-leaf widening/quadratic taper and reduced root darkening. Preserve roots, tips, centerlines, normals, topology and instance settings; retained clumps and raster cost can change.
- [x] Final focused runs: **36 Appearance + 31 Wind + 102 Grounding + 37 Generation + 183 runtime-policy = 389 passing tests**. Shared `tsc --noEmit` and development build exit 0. Archived geometry hashes remain exact; this is **not fresh full source/world/native qualification**.
- [x] Fix a real tree-startup race: the deferred pool setup left **27 of 48 trees** without rendered owners/proxies despite no pending pool work. Initialize against Stage's existing Scene before asynchronous world/resource registration. **Two successive reloads show 48/48 actual owners and attached proxies**; this does not prove every reconnect scenario.
- [x] Review two complete-scene native WebGPU images. Connected green volume improves and isolated dark stems reduce. Earlier night/stale-bundle/missing-tree images remain debugging evidence, **not valid complete-scene art A/B**.
- [ ] Improve asymmetric physical pond contacts, soil/grass integration, bright lawn collars, smooth paths, uniform olive coloration and disconnected dressing. Preserve fishing access, free traversal, water coverage, collision/worker agreement and resource ownership.
- [ ] Freeze a visually credible batch, then run complete source/world/native qualification plus motion/shimmer, LOD return, walking, loading/memory, representative frame cost and sustained gameplay/streaming.
- [ ] Keep native39's two grounding-budget failures open; absence in this lightweight, nonmatched preview is not a causal fix or reliability proof.

**Evidence scope:** preview41 used the existing isolated development launcher and world20 manifests. No new qualification receipt/world derivation or default promotion. Across six loaded documents it retained **30 console errors** (24 cow-specific + six generic 404s), with no observed page errors or grounding-failure messages; exhaustive GPU-warning and frame-cost evidence was not collected. No gear suite, motion, walking or endurance test ran. Camera/HUD/observer ownership was restored, browser/services retired and only the verified stopped disposable database/sole-use volume removed.

Candidate39/world20/replay53/native40 remain historical evidence for their frozen source, not qualification of these later changes. All earlier errors, rejected images and native40/native39 history remain intact.

[Preview41 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-preview41-UNQUALIFIED/README.md) · [Current details](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)

## Prior checkpoint — native40 bank-first review complete; visual acceptance remained open

**World first; avatar/armor later. One arena, SOL only.** The saved grass/bank images, portfolio projects and primary Three.js examples remain the targets. Native40 shows a modest local improvement, **not accepted art, AAA quality or production qualification**.

- [x] Share three connected service-approach wear ribbons between soil composition and vertical grass/wind/grounding scale. Keep root eligibility, building clearances, navigation and defaults unchanged. Seven physical maps / **27 ground gradient reads**; no measured cost claim.
- [x] Candidate39: **1,495/1,495 in 72 files**, zero semantic diagnostics and both builds; **181 current pins** verified. World20: derive/fresh verification **9/9 each**, **192 pins / 41 unchanged manifests / 15 direct original-asset links**. Replay53: **467/467**, all 31 pins verified. Earlier failed tests and runs remain.
- [x] Native40: exactly **three 1280×720 bank/campus/pond views**, with completed focused coastal and bank-review admission. All **917 source pins / 821 executed archives / three PNG hashes** independently verified.
- [x] Add bounded grounding-failure context without raising budgets. The required pond hold lasted **60,008.97575 ms**, including **5,871.584292 ms** settling. Natural daylight then added **167,335 ms**; actual pond-pose-to-photo exposure was **226,909.4 ms**, with no grounding errors. This is **not a fix claim** or matched-condition proof against native39’s ~239-second pond wait.
- [x] Review all three images: the local apron improves modestly, but thin dark stems, a bright uniform lawn, smooth collars and regular pond contacts persist. **Visual acceptance remains open.**
- [ ] Next: materially improve meadow-wide upper-blade silhouette, root shading and substrate integration, retaining shared wind/normal/grounding correctness and explicit performance budgets.
- [ ] Then improve asymmetric pond contacts and surrounding composition without sacrificing free traversal, resource/service access or ownership.
- [ ] Keep native39’s two grounding-budget failures open until diagnosed and tested with representative exposure; absence in this nonmatched run does not erase them.
- [ ] Qualify motion/shimmer, LOD return, walking, loading/memory, balanced frame cost and sustained gameplay/streaming after the art direction is credible.

**Faster iteration:** use the existing isolated launch helper, development client and shared-build reload for explicitly **UNQUALIFIED development previews**. Reuse existing cameras; do not bypass source-pin checks or label previews as receipts. Freeze a credible art batch before complete qualification and fresh native evidence.

Native40 remains **overall/study=false, exit 1**, with **19 retained console errors** (14 dagger-fit, four cow-specific and one generic 404); GPU/page/cleanup errors are empty. No clips, motion, walking or cost probe ran. Browser/services retired; only the verified stopped disposable database and sole-use volume were removed. All media/source evidence remains. Native39’s failures, native38’s rejection and all older history remain intact. No default promotion or production approval.

[Current details](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)

## Prior checkpoint — native dirt comparison improved; motion and cost remained open

**Compact island/world first; avatar and armor later.** One arena, SOL only.
The user's grass/bank images, portfolio references and primary Three.js examples
remain the art direction. Source checks are not AAA visual acceptance.

- [x] Wire explicit `dirtProjection=stochastic-v1` only into the admitted fine-meadow stream preview with compact sculpt terrain; capture selection once before material creation. Reject duplicate/incompatible options. Absence keeps the original 20-read material; the candidate uses 22 reads and the same six maps.
- [x] Candidate35: **1,449/1,449 tests in 72 files**, ordinary semantic check **735 roots / 2,378 files / zero diagnostics**, shared/server builds. Independently verified all **179 source pins / 61,815,920 bytes**, before/after equality, qualifier, command logs and test JSON.
- [x] World17: derivation and fresh verification **9/9** each; all **41 world16 manifests** remain byte-exact. Independently checked 190 source pins and inherited proofs. Fifteen verified directory links reuse original assets; no asset copies or default promotion.
- [x] Research application: triangle-patch stochastic sampling, explicit gradients and mip/contrast risks informed by Heitz/Neyret, Unity's published implementation and primary Three.js WebGPU terrain/filtering examples. Our linear-albedo compensation is approximate, not full histogram preservation.
- [x] Replay46 **406/406**; all 27 source pins unchanged and independently verified. Replay45's three stale test expectations were corrected; its failed receipt remains intact.
- [x] Capture native32 control and native33 candidate on the same current source/world. Independently verify each run's **915 source pins, 819 executed archives and seven PNG hashes**. Actual compiled control/candidate shaders use **20/22 reads**, respectively, with paired dirt maps sampled twice/three times.
- [x] Compare stills: the regular pale rows/dots are reduced; near-bank pebble detail and close rock definition remain. Independent review favors the candidate for further qualification, but calls the improvement modest. Broad mottling, soft green borders and artificial path shapes remain.
- [x] All seven camera/settings pairs match. The first five views pass before/after natural-light matching; **bank and campus exceed the unchanged 0.003 phase tolerance** and are not matched-light color evidence.
- [ ] Accept the dirt fix only after bank texture detail, color, seams, oblique filtering, motion/shimmer and representative frame cost are demonstrated.
- [ ] Then continue grass LOD convergence/fullness, natural paths, landform/ground/water cohesion, resource-linked vegetation and freely traversable open ground.
- [ ] Full traversal, loading, memory, frame-cost, long-duration gameplay/stream and overall visual acceptance remain open.

Candidate35 receipt SHA256:
`e0630269a7a55e9b3e4c21fcdbc6075a4ee3acc19a37bda10d2caa2f4cfd9eac`.
World17 receipt SHA256:
`5645a638d417b1af31ec173d9e8693e5f527ffaae4b2fd52919aa47e757b62cf`.
Native33 capture completed with zero GPU/page/study/cleanup errors and launcher
exit 0. Both runs retain the same 19 console errors (14 dagger, four cow-specific,
one generic 404); overall approval remains false. Native32's overall run also
failed client shutdown (SIGKILL required, then EPERM inspection), despite complete
capture admission and eventual process/port cleanup. Neither failure is waived.
No motion, traversal or GPU-cost measurement was performed. The two exact stopped
disposable test databases were removed; all evidence and original assets remain.
No production/default approval, commit or push.

Native32 report SHA256:
`da34e2d299f5f59464ffeb242e01652c2cbe458e3d075f3759e2176212d7fd15`.
Native33 report SHA256:
`9f04242a5e9f335650761ef603bf1809644216bb5fbf243c29fbad4c0f472e71`.

[Current details](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)

## Prior checkpoint — dirt candidate source qualified; native art/performance acceptance remains open

**Compact island/world first; avatar and armor later.** One arena, SOL only,
no large-island preservation requirement. The user's fine-grass image, supplied
portfolios, Rainy Worlds and primary Three.js examples remain the visual targets.
Bruno's grass source guides shared ground/blade color and spatial variation,
not camera-facing geometry or hidden performance compromises.

- [x] Candidate34: **1,440/1,440 tests in 72 files**, ordinary shared semantic check **735 roots / 2,378 files / zero diagnostics**, shared/server builds. Independently verified all **179 source pins / 61,802,510 bytes**, before/after equality, qualifier source, four command logs and tests JSON.
- [x] Historical candidate33/world16/v14 qualified the native31 checkpoint. Three material/test files have since changed; those old receipts do not admit current source or a new candidate preview.
- [x] Implement explicit optional `compactDirtProjection: "stochastic-v1"`: dirt-only three-patch triangular projection, signed PCG hash, paired gradients and approximate linear-albedo variance compensation. It is **not wired into live TerrainSystem selection or enabled by default**. Source surface-read budget is **22 instead of 20**, not measured GPU cost.
- [x] Native29: all seven world views and actual mask/root storage proof for 16 submitted pipelines within the eight-vertex-buffer limit. Native28's unsettled-queue/shutdown failure remains retained.
- [x] Qualify the separate opt-in dirt diagnostic: Replay43 **392/392**, all 27 pins unchanged; original 15-second coastal daylight gate retained, separate bounded 30-second diagnostic gate verified.
- [x] Native31: seven ordinary views followed by five same-camera, naturally daylit dirt trials on actual Apple Metal/WebGPU. All **917 then-current pins / 821 executed archives / 12 PNG hashes** independently verified; zero GPU/page/device errors. Diagnostic completed in **2.632 seconds**, with exact original graph, shader and native texture bindings restored before temporary-resource disposal.
- [x] Review all five dirt images: reusing the existing **0.006 meadow selector is insufficient**. No trial is accepted as the finished material; preserve this negative visual result.
- [ ] **Current user priority: remove the visible dirt-bank grid.** Source qualification is complete, but explicit isolated preview selection, fresh detached-world admission, native original/candidate bank comparison, motion and actual cost checks remain open. Preserve soil detail, paired normal gradients, world anchoring, geometry and free navigation. No stochastic-candidate native capture exists yet. Complete this before the grass-width trial.
- [x] Correct the future exact opt-in fog-capture inventory: **87/87 focused + 5/5 targeted checks** passed. Native31 still retains its immutable **12 != 7** failure; qualifying the future inventory does not relabel that run.
- [ ] Fix camera-driven grass LOD convergence. Native31 cut-to-settled times: **6.05 s bank / 7.66 s campus-link**. Its recorded **5.9 ms maximum slice is cumulative and already present at initial readiness**, not a newly measured cut-specific overshoot; the existing 2 ms preparation target remains open. Diagnostic waiting is not seamless-transition acceptance.
- [ ] Fuller meadow: isolated width **0.045 → 0.060** trial, then coherent height/color patches and terrain/blade integration. Hold population, height, wind, lighting and cameras during the width test; inspect motion and actual cost.
- [ ] Improve the larger composition: irregular natural path shoulders/arrivals, varied coastal landform and rock contacts, richer ground textures, pond/ocean integration, resource-linked vegetation and freely traversable open ground.
- [ ] Complete motion, traversal, LOD-return, loading, memory, frame-cost and long-duration gameplay/stream acceptance. No default promotion or AAA/production approval.

Native31's overall exit remains **1**, with `coastalCaptureCompleted=false`:
its only cleanup assertion is **12 != 7** in fog-screenshot inventory. The
observer itself restored, all 12 observations completed without errors, and the
separate dirt diagnostic completed/restored successfully. Five cow-404-related
console errors and 14 known dagger-fit errors also remain; full gameplay,
movement, cost and native lifetime qualification were not performed. These
deferred assets stay open, not silently accepted as production success.

Replay44 remains **364/394, exit1**: all 30 failures stopped at the same strict
stale candidate33/world16 source-pin gate. They are not assumed passes; the
harness still needs fresh candidate/world admission. No gate was weakened.

Candidate34 receipt: 107,285 bytes, SHA256
`61bfca700a5b846ec27e6d23fb157badbae96cf358fed6290f97d34a2c420e66`.
Native31 report SHA256:
`f0769acedf72d8ff4d2c2fc6e469ccb62b5923f45e6100c646faef90603e5948`.
The source verification describes that run's frozen checkpoint, not any later
anti-tiling edits. All historical reports, source archives and images remain.
Owned browser/services closed cleanly (launcher exit0); only the exact stopped
native31 disposable database container and sole-use volume were removed after
identity checks. No user database, original asset or source was deleted.
No production material/default was adopted from these trials. No commit or push.

[Current details](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)

## Prior checkpoint — worn-turf source and shader verified; full visual review pending

World first; avatar/armor remains deferred. The current material pass follows the
original fine-grass reference, Three.js terrain boundaries and the saved portfolio
references. It shares irregular wear between terrain and grass-root color without
changing map geometry, navigation, grass placement or density.

[Detailed evidence and remaining work](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)

- [x] Candidate20: **1,288/1,288**, zero type diagnostics, both builds; 177 pins verified.
- [x] World09: separate fresh startup, 188 pins, 41 unchanged manifests, 15 resource links.
- [x] V7 harness plus bounded failure diagnostics: **276/276**, 21 unchanged pins.
- [x] Real workers preserve default/placement behavior; no new material texture assets.
- [x] Native18's saved compiled terrain shader retains the same 40 sampling sites and 14 texture owners.
- [ ] Complete seven-view visual review; native18 produced only the shoreline-low image.
- [ ] Resolve native17's unproven ownership/maintenance rejection; its failure remains retained.
- [ ] Resume GPU testing only under stable, awake, adequately cooled host conditions.
- [ ] Verify natural path/ground appearance, movement, shimmer, LOD return and free navigation.
- [ ] Meet representative frame/loading/memory budgets and the full world art acceptance bar.

Native17 failed before world capture with 409 and two cleanup errors. Native18
passed both bots' setup but exceeded its deadline after the first photo. macOS
records 985 seconds of Thermal Emergency Sleep during that run; it is not a valid
performance or full visual result. No power/sleep safety control was bypassed.
GPU-heavy runs are paused while saved evidence/source review continues.

The compiled shader observation proves a finite source-level sampling bound,
not equal hardware cost. No path-quality, AAA, default or production approval.
Native16 remains the latest completed seven-view baseline; failed17/18 are not
retrospectively approved. Earlier density-comparison caveats remain.

## Research follow-up — 2026-09-20 measured rendering cost

The compact dock timber study also references the official
[procedural wood example](https://threejs.org/examples/webgpu_tsl_wood.html) and
its [r186 WoodNodeMaterial source](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/materials/WoodNodeMaterial.js).
The useful idea is a local growth volume shared by side and cut faces, with
warped rings and varied spacing. Hyperia's candidate uses one existing noise
sample and one filtered growth wave, plus stable dock/member/board identity;
it does not transplant the example's multiscale/Voronoi material. The existing
geometry, physical deck surface, texture count and shared material are retained.
Source/graph tests do not establish final material appearance or GPU performance;
actual submitted WGSL and close, grazing and moving views remain required.

The official [r186 forest material](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/generators/ForestGenerator.js)
uses a TSL branch to skip distant detail noise. The bounded inference for our
terrain is to investigate arithmetic whose existing normal contribution is
already exactly zero, after inspecting compiled WGSL. Keep derivatives valid,
retain packed AO reads and compare grazing and fade-boundary pixels. This is
an investigation, not an implemented optimization or permission to reduce
visible detail.

The accompanying [static-world example](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_custom_fog.html)
updates its shadow map on sun/geometry changes. Our animated trees and avatars
make a blanket shadow freeze unsafe. Any reuse or caster partition needs
actual owner/bounds evidence and unchanged moving-shadow coverage. No such
rendering change is approved by the isolated timing diagnostic.

## Research application — 2026-09-17 dirt-bank anti-tiling

The user reiterated that implementation must follow strong public references,
not stop at a small visual improvement. The current decision is to compare the
actual game material against the following primary sources, preserving WebGPU,
canonical terrain/navigation and the existing quality/performance targets.

- [Heitz/Neyret, High-Performance By-Example Noise](https://eheitzresearch.wordpress.com/722-2/):
  triangle-grid patches remove periodic repetition, but ordinary blending can
  lose contrast and change color distributions. Our three-patch candidate uses
  bounded linear mean/variance compensation, **not** the paper's full
  Gaussianization/inverse-histogram method. Check new triangular patches,
  pebble definition, clipping and apparent soil scale in the game.
- [Deliot/Heitz, practical stochastic texturing](https://eheitzresearch.wordpress.com/738-2/)
  and [Unity Labs implementation](https://github.com/UnityLabs/procedural-stochastic-texturing/blob/master/Editor/ProceduralTexture2D/SampleProceduralTexture2DNode.cs):
  explicit sampling gradients and mip-aware inverse transforms address filtering
  and color drift. The candidate's two packed maps use identical transformed
  gradients; its native mip appearance is still unverified. If the bounded
  approximation washes out or creates contrast patches, evaluate the fuller
  transform/prefiltering route rather than approving a blurred result.
- [Official Three.js WebGPU anisotropic filtering example](https://threejs.org/examples/webgpu_textures_anisotropy.html):
  use grazing-angle ground views to assess clarity and filtering cost. Hold the
  existing anisotropy constant in the first A/B; do not mix a sampler-quality
  change into the projection comparison or hide a cost increase.
- [Official r186 procedural-terrain source](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_tsl_procedural_terrain.html):
  inspect domain-warped form, height/slope material composition, environment and
  shadow relationships. Its standalone GPU-displaced 500×500 grid and simple
  transmission-water plane are **not** drop-in replacements for our streamed,
  authoritative world and agent-navigation surface.

Applied evidence: native32/33 use fresh control/candidate startups on identical
qualified world manifests, seven views at 1280×720/DPR1, and independently
observed soil-map bindings/compiled read counts. Repeated pale rows are less
regular without obvious near-bank detail loss: a modest still-art improvement,
not final acceptance. Five views meet lighting-match tolerances; the bank and
campus views exceed phase tolerance and cannot establish exact color changes.
Next use an explicitly scoped bank dolly and separate non-recording GPU windows.
Keep natural daylight, grass residency, scene population, exposure and quality
constant within measured tolerances.
Neither a demo, a CPU correlation test, nor a source sample count proves AAA
appearance or acceptable gameplay cost.

## Timing interpretation for the dirt motion/cost gate — 2026-09-17

The new opt-in diagnostic reuses the existing real Three.js render/compute
timestamp-pool observer rather than treating RAF callbacks or screenshot time
as GPU cost. The [official WebGPU timestamp-query sample](https://webgpu.github.io/webgpu-samples/?sample=timestampQuery)
is a primary API reference. [Chrome's developer-feature documentation](https://developer.chrome.com/docs/web-platform/webgpu/developer-features)
describes default timestamp quantization and the development-only precision
override. The current Chrome launch does **not** enable that override; no
browser privacy/developer setting is changed for this experiment. Extra decimal
places in a reported duration do not establish matching measurement precision.

Keep query windows separate from video encoding, screenshot observers and scene
censuses. Preserve raw samples, device identity and actual native query cleanup.
Compare distributions and stalls, not one rounded average. GPU pass sums omit
copies, idle and presentation; CPU/GPU work overlaps, so adding the two is not
an end-to-end frame measurement. A small single-pair difference requires repeat
balanced runs, not an unsupported claim that the candidate is faster.

This remains a 1280×720/DPR1/MSAA4 diagnostic on the current Apple M5/24GiB
development machine, with unchanged scene/quality and AC power. It does not
qualify minimum client hardware, deployment encoding, gameplay population or
the sustained60FPS launch target. Native34/35 now contain separately recorded
duration-only query windows and camera clips. Their matched settings and
lighting do not resolve a measurement limitation: raw absolute GPU begin/end
timestamps were reduced to durations before retention. Summed durations exceed
the host observation span without a correspondingly growing resolve delay, so
exclusive frame cost or queue backlog cannot be inferred. r186 also has a
render-pass resume path that can reuse a timestamp descriptor without another
context-ledger entry; that path's involvement here is not established.

Next retain exact decimal-string begin/end values at the existing mapped-buffer
read and a bounded actual pass-begin/write-index ledger, without another GPU
readback. The current r186 implementation subtracts BigInts before converting
the difference to Number; its observed duration grid is not evidence of a known
hardware precision. Preserve the original receipts as exploratory, not approved
performance data. Repeat balanced comparisons only after accounting is verified.

The [GPUWeb community-group discussion of November 8, 2023](https://github.com/gpuweb/gpuweb/wiki/GPU-Web-2023-11-08)
explains why independent Metal work may overlap or reorder. Consequently, the
new observer must not require GPU interval order to equal JavaScript submission
order. Observe physical pass descriptors, query slots, resolve/copy ownership
and submissions, and retain the existing mapped BigUint64 values as decimal
strings. Check slot reuse separately from legitimate overlap. A union of queried
spans still omits unqueried work and is not end-to-end frame time or FPS. This is
an interpretation rule, not proof of what happened in native34/35.


## Natural path edges — primary-source follow-up, 2026-09-17

These inform the next world-art trial; no external code or assets were copied,
and no runtime/default change or performance acceptance is implied.

- [Terrain3D's path-painting guidance](https://github.com/TokisanGames/Terrain3D/blob/main/doc/docs/texture_painting.md)
  separates a coherent path core from irregular grass/dirt edge mixing and
  combines authored areas with automatic terrain coverage. Application here:
  inspect and refine the existing world-anchored mask's unequal shoulders,
  grass intrusions and worn arrivals, while preserving traversability. Existing
  shared road/grass fields already do part of this; avoid layering a competing
  mask on top. Prefer generation-time variation before adding live texture reads.
- [Terrain3D's original shader](https://github.com/TokisanGames/Terrain3D/blob/main/src/shaders/main.glsl)
  accumulates height-sensitive material weights and normalizes PBR channels.
  That is a possible later micro-transition technique, not a drop-in: its
  channel packing differs from Hyperia's occupied roughness/AO channels, and its
  neighboring lookups/nonlinear weighting have a cost. Do not treat albedo,
  roughness or AO as measured height. [Code license](https://github.com/TokisanGames/Terrain3D/blob/main/LICENSE.txt):
  MIT; retain notices if code is reused and verify any texture licenses separately.
- [THREE.Terrain's material implementation](https://raw.githubusercontent.com/IceCreamYou/THREE.Terrain/master/src/materials.js)
  makes layer weights explicit through position/height expressions. The useful
  idea is a coherent influence field, not its renderer implementation: this is
  WebGL shader patching, with an added sample for each layer and defaults such
  as Phong, double-sided rendering and boosted saturation that we should not
  import. Hyperia stays WebGPU/TSL. [Code license](https://github.com/IceCreamYou/THREE.Terrain/blob/gh-pages/LICENSE.txt): MIT.

Acceptance stays visual and measured: natural connected wear at near/mid/far
views, no uniform green halo, no new tiling or shimmer, intact off-path movement,
and unchanged quality settings when comparing cost. First finish the current
dirt motion comparison; do not mix new path changes into its control/candidate.

### Bounded next trial: existing shared path-mask recipe

Read-only review of the current source identifies broad continuous shoulders:
pond-bank has a 0.325 m core radius plus 1.075 m blend, and bank-lobby has a
0.45 m core radius plus 1.15 m blend. Cubic capsule falloff, material remapping
and raw-mask grass thinning together explain a plausible source of the smooth
green borders. This is a source-supported diagnosis, not visual approval of a fix.

[Terrain3D's shader design](https://terrain3d.readthedocs.io/en/stable/docs/shader_design.html)
separates control-map coverage from material-detail lookup; [THREE.Terrain's
grass example](https://github.com/IceCreamYou/THREE.Terrain) aligns grass placement
with ground-layer coverage. Applied here: narrow the continuous shoulders and
redistribute partial wear through the existing unequal skirts, without another
shader layer. Retain route centerlines, surface heights, station/floor endpoints,
platform arrivals, MAX union, the fixed 256 mask and existing segment budgets.

- [ ] Compare actual raster coverage: less continuous intermediate-weight band,
  connected irregular wear, no isolated dots, scalloping or wider saturated core.
- [ ] Verify full capsule plus bilinear footprint clearance around water, lodge
  and non-target floors; partial skirts stay below the 0.8 full-clear threshold.
- [ ] Verify real worker/fallback parity, determinism and swept-blade clearance.
  Changed masks can change clump populations and acceptance-dependent RNG;
  unchanged placement inside affected cells is not promised.
- [ ] Review matched bank, pond, campus and low-oblique views, then motion and
  actual cost. Verify unrestricted off-path movement and station approaches.

Keep the shader and dirt projection fixed for that trial. Only consider a later
CPU/TSL weight-remap consolidation if the green halo persists. No path source
was changed during this research; the current dirt measurement pair stays frozen.

The first numeric trial is deliberately small: pond-bank blend 1.075 → 0.60 m;
bank-lobby 1.15 → 0.85 m; bank-apron 1.00 → 0.60 m; clerk approach 0.75 →
0.45 m; shopkeeper approach 0.625 → 0.45 m. Retain their current widths and all
existing skirt controls/peaks. Narrower continuous shoulders should reveal the
already-authored asymmetry; judge that prediction in the actual scene. The
bank-lobby choice retains a 0.20 m derived arrival feather; a 0.65 m blend would
collapse it to zero. Nonzero support may retract but must remain inside the old
support, with no fixed-domain change. Independently pin historical recipe values
before changing current expectations so earlier native19/native23 measurements
and their regression assertions remain meaningful.

## Reference decisions — 2026-09-16 world-first review

### Applying the references to the bank verge

The original grass image and [Bruno's grass source](https://github.com/brunosimon/folio-2025/blob/main/sources/Game/World/Grass.js)
inform continuous fine-blade coverage, ground/grass color continuity and spatial
variation. [Three.js's r186 terrain example](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_tsl_procedural_terrain.html)
informs deliberate material transitions. These are design references, not code
or asset imports and not evidence that our scene meets their visual standard.

The next bounded bank pass narrows three existing painted service cores while
preserving their outer support, centerlines and all navigation. It removes a
second material-edge threshold locally and tests a short-clump verge. The
existing clump scale also changes width: this is **not** height-only mowing, and
shrinking the footprint can make sparse coverage worse. Acceptance requires a
fresh bank-camera comparison and moving-camera review; numerical tests alone
must not mark this visual task complete. No global grass-density increase,
additional terrain texture or world-height change is part of this pass.

The supplied portfolios, Rainy Worlds, official Three.js examples and original
fine-grass image remain the visual targets. The task is to apply their relevant
strengths to our playable island, not simply collect more links. Avatar/armor
polish remains deferred. This review changes no runtime source or world profile.

| Reference | Concrete application | Acceptance required |
| --- | --- | --- |
| [Original grass reference](/Users/lucid/Documents/hyperia/asset-studio/haven-architecture01/user-grass-reference01.png), [Ameen's grassland](https://above-the-grassland.pages.dev/), [Bruno's grass source](https://github.com/brunosimon/folio-2025/blob/main/sources/Game/World/Grass.js) | Fine overlapping blades, varied height and connected ground/vegetation color; avoid the uniform lawn. | Near/mid/far motion, stable LOD and measured population/overdraw cost; no density promotion from a still. |
| [Jaime's Gaea source](https://github.com/JaimeTorrealba/creative-lab/blob/d2003439fae35078ebcefdd40176d39e7b293fcd/src/components/demos/d-g/Gaea.vue), [Three.js r186 terrain](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_tsl_procedural_terrain.html) | Deliberate broad forms and irregular material boundaries, rather than repeated rounded landforms. | Correct canonical/worker/visible terrain agreement, open-ground traversal and matched overview/shore views. |
| [Poly Haven coastal cliff](https://polyhaven.com/a/coastal_cliff_01), [Verdant Trail field reference](https://blog.polyhaven.com/verdant-trail/) | Unequal rock shoulders, visible planes and broken vegetation contacts instead of one continuous brown wall. | Local shape and contact review; protect resource/support locations and the downstream descent. |
| [Rainy Worlds](https://rainyworlds.com/) and the other supplied portfolios below | Layered foreground/midground/background, coherent sky/light/water and atmosphere. | Preserve combat visibility and test actual frame/memory/loading budgets; do not assume a portfolio's cost matches our agents and streaming workload. |

Fresh visual review covered Poly Haven's cliff front preview and its published
field photograph of a vegetated cliff, alongside our saved native16 overview
and native18 shoreline image. The temporary reference tab was closed. These
show why silhouette, large rock planes and irregular vegetation contacts deserve
attention before another texture swap. This is our art-direction inference,
not a new live review of every portfolio or proof of an in-game improvement.

The installed [Rock Face 03](https://polyhaven.com/a/rock_face_03) is already a
CC0 scan, with local provenance. The newly reviewed Coastal Cliff 01 is listed
as 92 m wide and 866K triangles: it is a shape reference, **not an approved
runtime import**. No asset was downloaded. Poly Haven's [asset license](https://polyhaven.com/license)
covers its assets; do not treat site photographs, previews or text as CC0 assets.

Source review confirms that the cove head is constructed from a half-ellipse,
while much of the existing broad descent lies farther downstream. A read-only
trial moving `coastalApron.lowland.startX` from 462 to 430 was **rejected**, not
installed: it alters existing headwater and worsens a sampled approach grade.
[Exact diagnostic and next shaping constraint](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md#reference-led-cove-head-diagnostic--2026-09-16).

Do not reimplement techniques we already have: dual-projection anti-tiling,
triplanar rock, explicit gradients, projected normal frames and contrast
compensation already exist. The current surface graph has 20 sample sites,
not a measured GPU-time guarantee. A strongly stratified replacement scan
would also need coherent rock orientation; unrestricted rotations can break
its bedding direction. Keep that a separate, visually verified material trial.
[Regional terrain controls in GPU Gems](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-1-generating-complex-procedural-terrains-using-gpu)
inform locally controlled shapes, not adoption of its voxel renderer or copied
demo code. No external code, dependency, asset or unqualified default was added.

## Earlier checkpoint — native16 bank views captured; visual refinement still needed

[Current implementation and evidence](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)
uses our saved portfolio/Three.js references and original fine-grass reference.
World remains first; avatar/armor work stays deferred. Three hooked platform
arrivals now use gradual curves. An explicit single-cell 0.60 m grass trial
retains 0.70 m everywhere else; the failed 0.50 m attempt is preserved and its
obsolete selector rejected. No safety budgets or blade shapes were relaxed.
The new bank candidate narrows three shoulders and adds two bounded unequal
wear patches. Native16 now captures this source through the exact v6/world08
selector. Bank/campus views show a small shoulder change, but stamped-looking
brown wear and uniform green turf remain; this is not full visual signoff.

- [x] Fresh bank candidate19: **1,281/1,281 tests**, zero type diagnostics, shared/server builds.
- [x] Independently verify all 177 source pins and command logs.
- [x] Detached world08: 35 groves, 21 supports, 23 paths/577 segments; 188 pins verified.
- [x] Verify 41 unchanged manifests and 15 original-asset directory links.
- [x] Qualify v5/world07 and optional trial admission: **257/257 harness checks**.
- [x] Capture and review seven world views and the first dedicated grass baseline.
- [x] Complete a real native GPU window, target-buffer checks and exact camera restoration.
- [x] Capture the 0.60 m cell candidate and return baseline under identical isolation.
- [x] Requalify all three saved probes; detect off-camera LOD/residency drift in strict comparison.
- [ ] Establish strict comparison acceptance; retain scene differences and native14 shutdown failure.
- [x] Qualify localized bank-shoulder/wear source: 23 paths/577 segments; same 256 mask.
- [x] Derive world08 and verify separate fresh startup; all 41 manifests match world07.
- [x] Qualify v6/world08 through replay19: **267/267 harness checks**, 21 unchanged pins.
- [x] Capture native16's seven world views and inspect its bank/campus approaches.
- [ ] Refine shared wear/turf materials against the saved portfolio/Three.js references.
- [ ] Verify motion/LOD return, free navigation, frame hitches and target-device performance.
- [ ] Refine painted path shoulders, uniform ground coverage and artificial pond margins.

**No art, full-performance, gameplay or AAA approval.**

[Replay18](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/equipped-lighting-replay18.json)
remains a failed receipt: three current-path tests still selected stale v5/q18
sources. Only those test references/admissions were corrected; runtime readiness
gates were unchanged. [Replay19](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/equipped-lighting-replay19.json)
then passed all 267 checks with 21 unchanged pins.

[Native16](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-native16/report.json)
is terminal **exit 1**, despite seven completed world photos and
`coastalCaptureCompleted: true`. There was no new grass probe or density trial.
The staged diagnostic remains incomplete. All five cow and fourteen dagger
errors are retained; page, GPU and cleanup error arrays are empty. The browser
closed, the launcher exited 0, and owned PIDs and ports were absent afterward.
The primary and independent reviewers verified 912 current pins (410,354,741
bytes) and 816 source archives (333,256,088 bytes). The original report remains
58,230,324 bytes, SHA256
`9ee4ec5c4a1e0442081991df54776d94930970fce18af6c9c8ac482830583707`.
Seven PNGs, fourteen RGB/pond boundaries and seven fog/HUD records were also
independently checked. Bank/campus camera poses match native15, but maximum
phase deltas 0.004175/0.005496 exceed the existing 0.003 limit: this supports
morphology review only, **not matched-light or color proof**. No cost, motion,
free-navigation or target-device performance acceptance follows from these stills.

[Native follow-up and evidence](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/grass-native-isolation01.md):
native13/14/15 each complete their separate grass probe and eight image purposes.
Target counts are 1,269 / 1,722 / 1,269. Native14's later launcher EPERM remains
a failed cleanup and its outer coastal-completion flag stays false; native15
restores and closes cleanly. All full runs retain the missing-cow errors and
separate dagger-fit blocker. Baseline13 has two extra non-grass meshes, so the
raw timings are not a density performance win. Source identity was independently
verified before the next bank-path edit. The saved comparison also rejects
non-target grass/LOD and resident-buffer differences, including two off-camera
cells in native14 versus15. Actual grass images remain too coarse
and strongly shadowed relative to the references. No density default is promoted.
Native11's reload and native12's incorrect expectation remain failed receipts.
The detailed checkpoint supersedes current-status statements below; older
receipts are preserved, not reclassified as proof of the new source.

## Current reference application — native13–15 review

The primary agent reopened [Above the Grassland](https://above-the-grassland.pages.dev/)
in a temporary browser tab after the GPU runs had ended. The loaded field was
visually inspected: uneven blade heights, layered greens, scattered flowers
and soft distance haze give it a less uniform composition than our native
close-ups. Its strong haze, grain and cinematic framing are not automatically
appropriate for readable combat. This was one live scene view, not a complete
weather, device or performance audit. The temporary tab was closed.

Primary source re-review also covered [Bruno's grass implementation](https://github.com/brunosimon/folio-2025/blob/main/sources/Game/World/Grass.js)
(shared terrain color, spatial height variation and wind) and [Three.js r186
terrain](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_tsl_procedural_terrain.html)
(height/slope regions and a noise-modulated boundary). These inform our
composition/material decisions, not a claim of imported code or equal cost.
Rainy Worlds and the other supplied portfolios remain saved references; the
text fetch for Rainy Worlds failed in this revisit, so it is not counted as a
new live review. The user's original fine-grass image remains the primary
grass-shape comparison. No external code/assets/dependencies were imported.

## Earlier checkpoint — path joins and pond detail

World work comes first; avatar and armor work remain deferred. These are
completed source checks, not new native art or performance acceptance.
The earlier checkpoints below remain preserved as history.

- Paths pass **18/18** focused checks. Three platform joins bring the selected
  network to **515 segments**, ten more than before, with the same **262,144-byte
  mask**. The measured lodge residue is **7.81564e-7**, bounded by **1e-6**;
  it is not zero.
- [Adaptive pond checks](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/pond-annulus-adaptive-geometry03.log)
  pass **37/37**, including 2,304 contours, 13,440 bank probes and all six
  asymmetric seams. Maximum radial error is **0.010425 m**; maximum full-bank
  vertical error is **0.006154 m**. Two leaves add **2,278,096 buffer bytes**.
  This is a geometry cost, not GPU performance approval. The candidate requires
  resolution 128; unsupported 64 and 32 cases fail closed.
- [Pond detail retention](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/pond-detail-retention-focused01.log)
  passes **9/9**. The 20 current planner layouts add no base-LOD geometry;
  the annular buffers above are a separate cost.
- [Precompile checks](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/pond-precompile-focused02.log)
  pass **28/28**. Startup now selects the admitted detail resolution for its
  sample rectangle instead of using streaming resolution 16 inside the pond.
  Original caps, cancellation and cleanup checks remain.
- [Integration04](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/annular-pond-integration-focused04.log)
  preserves the broad-travel checks across **7,082 cells**: maximum retained
  gap **0.014625 m** and angle **7.74262°**. Its expected-hash failure remains
  recorded; the golden was updated only after the full byte-level parity proof.

[Candidate17](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/southern-meadow-candidate17.json)
**passes 1,202/1,202 tests across 71 files**. Shared types have zero diagnostics
across 724 roots and 2,364 source files; shared and server builds exit 0.
All 177 source pins and command logs were independently reverified.
[Candidate16's failure](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/southern-meadow-candidate16.json)
is retained: all tests passed, but two typing errors stopped its builds.
Those corrections did not change runtime behavior.

[World06](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/southern-meadow-world06/receipt.json)
passes detached derivation and separate fresh-process verification.
All 188 detached pins were independently checked; the world has 21 supports,
18 paths and 35 materialized groves.
[Asset delivery is complete](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/southern-meadow-world06/ASSET_DELIVERY.md):
15 resource links are verified and all 41 manifests are byte-identical to world05.

[Replay13](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/equipped-lighting-replay13.json)
passed **228/228** in 32.027 seconds.
The latest [replay14](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/equipped-lighting-replay14.json)
passes **232/232** in 31.643 seconds. Both exited 0 with eleven unchanged pins;
the latest full log and pins were independently reverified. The v4 passive
per-photo daylight alignment now has CPU, archival and source checks.
It retains the original 15-second batch and all comparison limits.
**Native10 has finished with all seven world photos saved, but overall exit 1.**

- [x] Finish fresh source, type and build qualification.
- [x] Derive the detached world and verify a separate fresh startup.
- [x] Complete asset-link delivery checks.
- [x] Qualify the v4 harness through replay14.
- [x] Complete and inspect the seven-view native still capture.
- [ ] Qualify natural path joins, pond shores and wider world art.
- [ ] Verify camera motion, open-ground travel and measured performance.

[Native09 is preserved as a partial, exit-1 capture](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-native09/verification.md):
four of seven photos were saved. The pond daylight delta was **−0.0031587**,
outside the unchanged **±0.003** limit. Its 908 current source pins,
812 archives (**333,071,882 bytes**), four PNGs and eight pond boundaries
were independently checked. Browser and stack closure were verified and four
ports were clear. The missing supplemental photos remain recorded by fog
validation; this is not a complete capture or a cleanup-leak claim.
The original report and study are intact; source and geometry remain qualified.

[Native10 verification](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-native10/verification.md)
records all seven PNG hashes and dimensions, exact study/report equality,
908 current pins and 812 archives (**333,083,799 bytes**) independently checked.
All four passive daylight alignments completed and released within the original
15-second batch. Page, GPU and cleanup error arrays are empty. The browser
closed, launcher exited 0 and was absent, and no stack groups remained;
owned processes were absent and four OS ports were clear.
Five unexpected cow404 errors drive the overall exit 1. The 14 dagger-fit
messages remain a separate, deferred blocker. Both ten-second RAF windows
completed but remain unqualified; they are not a performance benchmark.

[All seven native10 stills were reviewed](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-native10/visual-review.md).
Platform gaps are closed, but the new short, hooked joins still look artificial.
The pond is smoother but retains a regular oval and uniform wet rim.
Sparse ground cover, the broad lawn, cove and sky quality remain open.
[Native08's earlier review](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-native08/visual-review.md)
and the failed native09 daylight comparison remain history.
Cow-placeholder work stays deferred. **Completed still inspection is not art,
camera-motion, traversal or performance approval. No default is promoted.**

Next proposed ground-cover trial, **not implemented**: use 0.50 m instead of
0.70 m clump spacing in just one admitted 25 m meadow cell, retaining slender
blades. This can raise candidate population and associated work by about
**1.96×** (1,276 to 2,500 attempts); budgets must remain unchanged.
Compare a fixed-count width trial against the user's fine, overlapping grass
reference. Wider blades may become coarse strips; denser blades can increase
raster overdraw. Neither unchanged counts nor passing placement caps establish
acceptable fragment cost or performance.

The existing [Ameen and Jaime mapping](/Users/lucid/Documents/hyperia/hyperia-implementation/docs/graphics-reference-library.md#user-supplied-portfolios),
[official Three.js terrain references](/Users/lucid/Documents/hyperia/hyperia-implementation/docs/graphics-reference-library.md#official-threejs-implementation-references)
and [Bruno world reference](/Users/lucid/Documents/hyperia/hyperia-implementation/docs/graphics-reference-library.md#additional-independently-located-references)
remain the design inputs. No external code or assets are imported by this work.

Research date: 2026-09-15. These are implementation and art-direction references,
not claims that Hyperia already matches them. No external code, models, textures,
audio, dependencies or renderer defaults were imported during this review.

## Review scope and practical priorities

Reviewed the user-supplied portfolios, their available project inventories and
selected primary source files. The official Three.js catalogue contains 607
entries across 14 categories, including 230 WebGPU examples. This is a complete
catalogue inventory, **not 607 demos visually tested**. The homepage identifies
r186; selected official source links below are pinned to that release.
[Catalogue](https://threejs.org/examples/files.json), [homepage](https://threejs.org/).

The implementation order below is our inference from the references and our
existing world defects. It is not a benchmark result from those sites.

| Priority | Apply to Hyperia | Evidence required before acceptance |
| --- | --- | --- |
| 1. Composition and terrain silhouette | Natural valley head, unequal banks, one dominant ridge shoulder; break up uniform lawn and mechanically repeated peaks. | Same-camera day views plus real traversal; retain functional slopes, resource anchors and collision/render contact. |
| 2. Ground and vegetation together | Matte dry soil; connected fine grass; irregular rock/soil/grass transitions, restrained flowers and understory. Keep choppable trees as the island's tree population. | Near/mid/far and moving-camera review; deterministic worker/fallback placement, resource-state/LOD transitions and unchanged navigation. |
| 3. Shore and water | Readable depth, foreground-safe refraction, coherent swell/fine normals and restrained edge foam. Pond and sea need distinct scale. | Banks, rocks and actors must not smear through water; verify shore contact, horizon stability and added passes/memory. |
| 4. Lighting and contact | Consistent sky, sun, environment, shadow softness and ambient occlusion; correct skin/armor under actual world lighting. | Equipped-avatar day/night views and motion; no blue skin, crushed armor, detached feet or AO halos. |
| 5. Life and atmosphere | Shared wind/weather driving grass, trees, mist, rain and sound; wetness only where weather/material warrants it. | Combat stays readable; no moving shadows baked permanently into terrain; bounded particles/audio and smooth transitions. |
| 6. Presentation and scale | Deliberate spectator transitions, unobstructed preparation/duel framing, stable distant LOD and staged shader compilation. | Real agents, equip/combat/gathering and stream capture; measured frame/loading/memory budgets at matched resolution and population. |

Use examples to improve the existing systems, not to stack every available
effect. A visually convincing isolated scene does not establish the cost of our
animated agents, equipment, networking, resource state and streaming workload.

Current WORLD FIRST mapping: [Ameen's grassland](https://above-the-grassland.pages.dev/)
informs coherent ground/vegetation color patches;
[Jaime's Gaea source](https://github.com/JaimeTorrealba/creative-lab/blob/d2003439fae35078ebcefdd40176d39e7b293fcd/src/components/demos/d-g/Gaea.vue)
informs an unequal dominant ridge/secondary shoulder;
[official Three.js terrain](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_tsl_procedural_terrain.html)
informs legible height/slope material structure. Hyperia's existing controls and
authoritative surface remain the implementation; no external code/assets were
copied. Candidate13 and detached world04 pass source/content qualification,
not visual adoption. The material candidate retains **20 surface texture fetches
unchanged** and adds **one additional fetch from the existing noise texture**:
three noise fetches versus the old Haven graph's two, not a claimed performance
gain. Replay11 passes **200/200 in 27.3 s**, source pins unchanged; replay10's
**198/200** failure is retained after correcting two stale-selector tests to v2.
Native07 is terminal **EXIT1** with v2/world04 RGB world-only capture. All five
coastal PNG/HUD captures pass on actual WebGPU at 1280×720/DPR1; the cow404
failed-asset/unexpected-console error causes the exit. Fourteen known dagger-fit
errors remain separately; armor/material audit and cow-placeholder work stay
deferred. Page/GPU and cleanup errors are empty; browser/stack cleanup, four empty
ports and unchanged sources are verified.
[Independent verification](../../asset-studio/game-test-integration/southern-meadow-native07/verification.md)
confirms all **811 archives / 302,738,630 bytes** match their hashes, plus the
five PNGs, RGB owners, exact HUD restoration and fog checks.
Scheduling was performed, not qualified, with moving cameras in both windows
and changed post-study population; this is not a controlled benchmark.
[Five-pair visual review](../../asset-studio/game-test-integration/southern-meadow-native07/visual-review.md)
supports an opt-in partial improvement in meadow color masses, cove descent and
skyline variation—not default promotion or AAA acceptance. The excavated bowl,
flat ridge crest, serrated pond, plain paths and sparse composition remain.

The reference-led path application now uses narrower pond-bank/bank-lobby cores
and four asymmetric partial-wear pieces, preserving original route points,
endpoints, terrain and services. [Focused03](../../asset-studio/fine-meadow01/natural-path-wear-focused03.log)
passes **16/16** with exact 256-mask positive support, bilinear keepouts,
connected cores and scalar/filtered asymmetry. Failed fixture01/mask512-02 remain.
Mask storage stays **262,144 bytes**, but segments increase **301→505**; this is
not unchanged CPU/worker or grass cost, nor reference-quality visual acceptance.
[Candidate15](../../asset-studio/fine-meadow01/southern-meadow-candidate15.json)
passes **1,162/1,162 across 70 files**, zero shared type diagnostics, shared/server
builds exit0 and 175 unchanged pins. Candidate14's four preexisting
`Object.hasOwn` typing failures remain recorded; only equivalent test calls changed.
[World05](../../asset-studio/fine-meadow01/southern-meadow-world05/receipt.json)
passes derivation and separate fresh startup: 186 checked current pins,
41 manifests identical to world04, 35 groves, 18 surface paths, 21 supports,
maximum grove slope **0.342429559198712**, 15 resource links and asset delivery.
[Replay12](../../asset-studio/fine-meadow01/equipped-lighting-replay12.json)
passes **223/223 across eight harness files in 28.572 s**, exit0, no
skips/failures/timeouts; eleven source pins unchanged and independently rechecked.
[Native08 verification](../../asset-studio/game-test-integration/southern-meadow-native08/verification.md):
power connected, v3/world05 terminal **EXIT1** with all **seven** world PNG/HUD
captures complete on actual WebGPU at 1280×720/DPR1. All 14 RGB boundaries and
seven fog rows pass; roof waits **45.245/1.354 ms** remain within 1,000 ms and
HUD totals **≤4.1 ms** retain the exact 450 ms limit. Study/report match;
**908 current pins and 812 archives / 332,963,653 bytes** independently match
their hashes. Cow404 causes five unexpected errors and EXIT1; 14 dagger-fit
errors remain separately. Page/GPU/cleanup errors are empty, browser closed,
launcher exited 0/absent and four ports independently clear. Both RAF windows
completed but are unqualified: moving cameras and changed post-study population
prevent a performance claim.
[Visual review](../../asset-studio/game-test-integration/southern-meadow-native08/visual-review.md):
partial progress, **not art-approved**; rounded/disconnected path ends, blurry
shoulders, sparse lawn and regular shores remain. The **301→505 segment** cost
is unresolved.
Existing shared mask/material owners remain authoritative; no new texture/pass
or default promotion. Next: continuous path-to-platform joins and meaningful
wear, not visible green gaps preserved merely for an old footprint golden;
protect actual navigation, collision and support. Separate pond-bank work uses
the [CPU feasibility experiment](../../asset-studio/fine-meadow01/pond-bank-feasibility.json)
([script](../../asset-studio/fine-meadow01/pond-bank-feasibility.mjs)): reconstructed
upper-contour maximum error **0.55610→0.09498 m**, 256 directions on resolution-128
leaves, adding **7,422 vertices, 14,712 triangles and 592,176 bytes** over two
leaves; same-level edge error is approximately floating-point epsilon.
This runs the real assembler/retained sampler with synthetic surroundings,
zero roads and a diagnostic square proxy—not a production solution or runtime
pond admission. Coarse-resolution-32 face-cap/bracketing failures remain;
proper annular refinement, LOD policy, contact, cost and native proof remain
unresolved. Increasing road-mask resolution is not a pond fix.

## User-supplied portfolios

### Ameen Abdullah

The [portfolio](https://ameen-abdullah.dev/) and [labs](https://ameen-abdullah.dev/labs)
list seven case studies and eleven experiments. All listed project/case-study
entries were reviewed; not every JavaScript-only demo was successfully rendered.

Case studies:

- [Becky Entertainment](https://ameen-abdullah.dev/projects/becky-entertainment)
- [The NCS](https://ameen-abdullah.dev/projects/the-ncs)
- [The Grid Manifesto](https://ameen-abdullah.dev/projects/grid)
- [Hardik Bhansali](https://ameen-abdullah.dev/projects/hardik-bhansali)
- [Dev from 2047](https://ameen-abdullah.dev/projects/rohit-harish)
- [Skull Crusher](https://ameen-abdullah.dev/projects/skull-crusher)
- [Tessarakt](https://ameen-abdullah.dev/projects/tesserakt)

Labs:

- [Above the Grassland](https://above-the-grassland.pages.dev/)
- [WebGL Gallery](https://slider-webgl-curved-1.vercel.app/)
- [Particles Reveal](https://particles-transition-webgpu.vercel.app/)
- [Noise Gradient](https://noisy-gradient-webgl.vercel.app/)
- [Ashfall Gallery](https://ashfall-webgl-gallery.vercel.app/)
- [Burn Transition](https://image-burn-webgl-effect.vercel.app/)
- [Fullscreen Transition](https://taotajima-fullscreen-webgl.vercel.app/)
- [Scene Transition](https://scene-transition-webgl-1.vercel.app/)
- [Text Transition](https://text-transition-webgl-1.vercel.app/)
- [Blinds WebGL](https://noise-hover-webgl-effect.vercel.app/)
- [Sound Car](https://sound-car-webgl.vercel.app/)

Live visual review inspected Above the Grassland's default and natural/noon
settings, and the portfolio's cherry-tree island. Particularly useful: layered
vegetation, larger patches of color, composed rock/bank/tree relationships and
atmospheric depth. Preserve gameplay readability rather than inheriting strong
grain, blur or chromatic fringes. A momentary site FPS counter is not a benchmark.

No grassland/island source repository or reuse license was verified. The author's
public [taotajima-effect source](https://github.com/Ameen-Abdullah/taotajima-effect)
is a different, small WebGL image-plane project, not that landscape engine; no
license was verified there either. The author's separate
[Below the Grassland announcement](https://www.linkedin.com/posts/ameen-abdullah_threejs-webgpu-activity-7498582568850796544-840_)
is an additional lead, not a verified source/live-demo dependency.

### Giulio v5

[Current v5](https://v5.theycallmegiulio.com/) was viewed live. Its atmospheric
framing, controlled camera movement and foreground/background separation are
useful spectator-presentation references. Its
[deployed application](https://v5.theycallmegiulio.com/assets/index-CLAoWNif.js)
constructs WebGPURenderer, contains Three r183, fixes DPR to 1 and uses a
half-resolution interaction compositor. These are bounded design choices, not
proof of an equivalent Hyperia frame rate. Active backend was not independently
probed in this portfolio review.

[Giulico/folio-2022](https://github.com/Giulico/folio-2022) is **v4**, not v5.
Do not attribute that older WebGL/React source to the current experience. No
public v5 repository or explicit reuse license was verified. Models and music
have separately listed credits on the site.

### Anderson Mancini

The live [portfolio](https://andersonmancini.dev/) exposes a 64-project catalogue,
including WebGPU and WebGL work. Its current links include
[Realistic Water](https://water-simulation.vercel.app/) (a WebGL pool study) and
[WebGPU ARCHIVIZ](https://planpoint-webgpu.vercel.app/); their project records do
not provide source links. The portfolio's rendered previews were viewed; those
previews are not independent execution/performance tests of every project.

The most relevant source lead for a populated island is the new
[Octahedral Impostor component](https://github.com/ektogamat/octahedral-impostor-component/tree/f94290693e0966dbb2e2dba89591734753a4582f),
with an [MIT license](https://github.com/ektogamat/octahedral-impostor-component/blob/f94290693e0966dbb2e2dba89591734753a4582f/LICENSE).
Inspect it as a distant-tree technique, not a ready replacement:

- [Field](https://github.com/ektogamat/octahedral-impostor-component/blob/f94290693e0966dbb2e2dba89591734753a4582f/src/impostor/ImpostorField.jsx): two-triangle cards blend atlas directions, but the demo disables frustum culling and updates every instance matrix each frame.
- [Baker](https://github.com/ektogamat/octahedral-impostor-component/blob/f94290693e0966dbb2e2dba89591734753a4582f/src/impostor/hooks/useOctahedralAtlas.js): temporary WebGL rendering and synchronous readbacks; unsuitable unchanged for our WebGPU-only runtime. Prefer an offline, revision-keyed, bounded asset pipeline if adopted.
- [Material](https://github.com/ektogamat/octahedral-impostor-component/blob/f94290693e0966dbb2e2dba89591734753a4582f/src/impostor/utils/createImpostorAtlasMaterial.js): unlit color atlas, not dynamically relit normals/depth. Day/night fidelity remains a gate.

The [r3f-webgpu-perf documentation](https://github.com/ektogamat/r3f-webgpu-perf)
explicitly labels GPU/CPU time as an estimated 20%/80% split. It cannot establish
our GPU budget. Also, [Three Graces](https://github.com/ektogamat/threejs-graces/blob/main/LICENSE.md)
has a noncommercial/no-derivatives license; public source is not automatically
commercially reusable. No component was installed.

### Henry Heffernan

[Portfolio](https://henryheffernan.com/) and
[outer source repository](https://github.com/henryjeff/portfolio-website).
The source's [BakedModel](https://github.com/henryjeff/portfolio-website/blob/master/src/Application/Utils/BakedModel.ts)
uses baked sRGB imagery with MeshBasicMaterial. Its convincing authored contact
and material separation are useful; they do not demonstrate expensive dynamic
lighting. [Camera states](https://github.com/henryjeff/portfolio-website/blob/master/src/Application/Camera/Camera.ts)
and [monitor interaction](https://github.com/henryjeff/portfolio-website/blob/master/src/Application/World/MonitorScreen.ts)
are relevant to focused preparation/loadout views and readable interaction.

The outer repo has an [MIT license](https://github.com/henryjeff/portfolio-website/blob/master/LICENSE.md),
despite stale package metadata saying UNLICENSED. The separate inner OS and
third-party media require their own checks. Full baked outdoor illumination
would not suit Hyperia's moving sun; asset-local detail/AO is a different option.

Live review observed the desk, chair, plant and their soft grounded contact;
the embedded desktop loaded, but its complete interaction flow was not tested.

### Jaime Torrealba

[Portfolio](https://jaimetorrealba.com/?ref=webgpu.com),
[151-demo lab](https://lab.jaimetorrealba.com/) and
[source revision](https://github.com/JaimeTorrealba/creative-lab/tree/d2003439fae35078ebcefdd40176d39e7b293fcd).
The complete route inventory and selected nature source were inspected, not all
151 scenes visually tested. Useful specific references:

| Demo/source | What to learn; what not to assume |
| --- | --- |
| [VirtualBotany planting](https://github.com/JaimeTorrealba/creative-lab/blob/d2003439fae35078ebcefdd40176d39e7b293fcd/src/components/demos/t-z/virtual-botany/planting.js) | Seeded patches, slope/rock exclusions and coordinated ground/clutter. Its static rock-shadow tint is not our runtime shadow model. |
| [VertexTextureWater](https://github.com/JaimeTorrealba/creative-lab/blob/d2003439fae35078ebcefdd40176d39e7b293fcd/src/components/demos/t-z/vertex-texture-water/buildWaterTextures.js) | Organize height and gradient detail efficiently; do not replace shoreline-conforming topology with a radial grid without contact/seam checks. |
| [EffectiveWater](https://github.com/JaimeTorrealba/creative-lab/blob/d2003439fae35078ebcefdd40176d39e7b293fcd/src/components/demos/d-g/effective-water/vertex.glsl) | Analytic wave derivatives; its simplified opaque plane lacks our shoreline/depth requirements. |
| [SimonGrass fragment](https://github.com/JaimeTorrealba/creative-lab/blob/d2003439fae35078ebcefdd40176d39e7b293fcd/src/components/demos/o-s/simon-grass/fragment.glsl) | Blade construction is worth studying, but this fragment outputs base color rather than its computed lighting. Not SSS/daylight proof. |
| [Gaea](https://github.com/JaimeTorrealba/creative-lab/blob/d2003439fae35078ebcefdd40176d39e7b293fcd/src/components/demos/d-g/Gaea.vue) | Authored silhouette reference; two baked textures displace a plane, not an authoritative procedural island system. |

These particular demos use GLSL/Tres/Vue, not drop-in TSL components. No LICENSE
file was found in the complete tree; the README's informal reuse encouragement
does not resolve each third-party asset's provenance. Study the techniques;
clarify permission before copying.

Live review additionally inspected the portfolio's moonlit tree/grass scene and
the VirtualBotany patch. The latter's varied ground cover and clustered accent
plants are composition references, not approval to blanket our traversable
island in the same density or tall foliage.

### Rainy Worlds

[Site](https://rainyworlds.com/) and inspected
[deployed application](https://rainyworlds.com/assets/index-VR26mEfy.js).
The UI offers six worlds and three quality levels. Live review inspected the
woodland entry and the wooded entry after selecting Headland; this was not a
complete six-world walkthrough or a verified view of its coastline.

Particularly relevant: one weather state connecting wind, foliage, rain, wetness
and sound; shared CPU/TSL terrain sampling; camera-local instanced rain; cheaper
distance geometry. Source contains r185 and WebGPURenderer, with a separate
coarse-pointer WebGL2 path. Quality changes resolution and effects together.
Shader-suppressed grass still has submission cost. Far terrain disables shadows;
that is not an acceptable invisible compromise for our near playable island.

The rain sound generator builds three eight-second stereo buffers at startup,
then loops/mixes them; other ambience uses recordings. This is a useful bounded
audio design, not thousands of new per-frame voices. No repository or reuse
license was verified. Borrow principles, not unlicensed deployed code or media.

## Official Three.js implementation references

All version-pinned source links here are r186, matching the workspace's installed
`three` package at `0.186.0`. The examples are compact demonstrations, not
complete game subsystems. Preserve our canonical terrain, resource ownership,
instancing, chunk streaming, LODs and equipment/animation contracts.

| Area | Exact official source | Integration consideration |
| --- | --- | --- |
| Terrain layering | [Procedural terrain](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_tsl_procedural_terrain.html) | Height/slope materials and warped noise; its 500,000-triangle GPU-displaced plane has no matching gameplay ground sampler. |
| Shore refraction | [Backdrop water](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_backdrop_water.html) | Study depth/foreground handling against our actual banks and pond. |
| Sea surface | [Ocean](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_ocean.html), [WaterMesh](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/objects/WaterMesh.js) | Animated normals, Fresnel and a planar reflection; not a bathymetric or FFT ocean. Reflection adds scene-render cost. |
| Local ripples | [Compute water](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_compute_water.html) | 128-squared ping-pong height simulation; prove timestep behavior and bound the interaction domain. |
| Sky and atmosphere | [SkyMesh](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/objects/SkyMesh.js), [fog scattering](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_custom_fog_scattering.html) | Coordinate sun/sky/fog. Do not copy the sky demo's every-frame cubemap update or treat blurred scattering as physical volumetrics. |
| Outdoor shadows | [Cascades](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_shadowmap_csm.html) | Four cascades in the demo add passes; compare contact, swimming and transition cost before adopting. |
| Ambient contact | [AO](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_postprocessing_ao.html) | Ambient-only composition, normal/depth/velocity inputs and temporal history; test moving actors and halo/ghosting behavior. |
| Many animated actors | [Individual instanced skinning](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_skinning_instancing_individual.html) | Reuses computed deformation across passes; CPU pose/bone uploads and instance-times-vertex storage still matter. |
| Startup and submission | [Async compile](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_compile_async.html), [render bundles](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_performance_renderbundle.html) | Await readiness; stable structures can reuse commands, but structural changes need invalidation. Neither removes GPU shading cost. |
| Surface distribution | [Instanced scatter](https://github.com/mrdoob/three.js/blob/r186/examples/webgl_instancing_scatter.html) | Sampling/instancing reference, not a reason to update static meadow matrices every frame. |

### Current VFX and procedural-grass transfer notes — 2026-09-20

| Reference | Transfer into this project | Do not copy blindly / cost gate |
| --- | --- | --- |
| [r186 linked particles](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_tsl_vfx_linkedparticles.html) | Reference the fixed storage buffers, explicit alive/lifetime state, modulo spawn cursor, and separate compute update/spawn stages when evaluating bounded pooled effects. | Its fixed `2^13` (8,192) slots do **not** prove that count is appropriate for the world or arena. The example also scans the full particle storage while finding links. Establish the real concurrent-effect census, overflow and cleanup behavior, then measure compute, draw and overdraw cost on target hardware. |
| [r186 volumetric fire](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_volume_fire.html) | Use the flame/smoke silhouette, motion, ramp and depth cues as an artist reference for a hero effect. | The source simulates 3D textures, ray marches a `VolumeNodeMaterial` at 16 steps, and adds a separate volumetric-shadow path. It is not the default furnace implementation. Prefer the existing authoritative pooled `ParticleManager`, then consider a tightly bounded volume only if measured overdraw, render-pass cost and stream readability justify it. |
| [Official live compute-particles example](https://threejs.org/examples/webgpu_compute_particles.html) | Reference the current compute init/update, instanced-array and sprite-rendering shape while researching future GPU-backed pools. | This live page is not the version-pinned integration source or a capacity benchmark. Reconfirm every API against local r186 and prove effect-specific frame, memory, fallback and cleanup behavior before adoption. |
| [GDC 2021 procedural-grass session](https://gdcvault.com/play/1027033/) | Its official abstract is a useful objective: GPU-generated individual blades with procedural appearance and animation, kept within explicit memory/performance limits and composed into a natural field. | It is a platform-specific conference reference, not a drop-in implementation or proof that the current grass meets quality or cost targets. Transfer the distribution, variation, animation and budgeting questions into our own traversal, navigation, stream-camera and target-hardware tests. |

This review inspected the linked source and the official session/page text. It did
not install a library, vendor example code or assets, change a runtime default,
or perform an interactive visual review of the live pages.

There is no grass-named example in the current catalogue: terrain's grass-colored
layer is not blade vegetation. Code carries the
[Three.js MIT license](https://github.com/mrdoob/three.js/blob/r186/LICENSE).
Check example assets separately; the water example's pool, for instance, has
separate attribution requirements.

Live browser review also inspected the procedural-terrain, AO and backdrop-water
examples. Those observations and source inspections are retained in this task;
no matched benchmark artifacts or complete example test suite were produced.

## Follow-up: outdoor lighting experiments

The next reference-driven lighting experiments should preserve the existing
environment owner and separate contact, sun shadows and temporal filtering.
These are proposed experiments, not installed effects or accepted results.

The official [AO example](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_postprocessing_ao.html#L108)
uses `builtinAOContext`, rather than multiplying the finished image by AO.
[ContextNode](https://github.com/mrdoob/three.js/blob/r186/src/nodes/core/ContextNode.js#L239)
skips transparent materials and combines screen-space AO with material AO.
[PhysicalLightingModel](https://github.com/mrdoob/three.js/blob/r186/src/nodes/functions/PhysicalLightingModel.js#L806)
applies it to indirect diffuse and roughness-dependent indirect specular—not
direct sun or emissive. Existing baked occlusion can therefore still become
too dark. Packed view-space normals are data: the example's sRGB conversion is
for its inspector preview, not the AO input. Keep normal/roughness/AO textures
out of color-transfer conversion; perform output conversion once after linear
lighting. [Color-management guidance](https://threejs.org/manual/en/color-management.html).

The AO selector is **not an equal-cost comparison**: its GTAO branch uses
half-resolution AO plus TRAA; SSAO selects full-resolution AO and 4× MSAA for
beauty. At a hypothetical fixed 1280×720 drawing buffer and half-resolution AO,
the AO target has 230,400 pixels. Source-level analytical work is:

- [SSAO](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/tsl/display/SSAONode.js#L255),
  16 samples: 3,686,400 neighboring depth lookups, plus center depth/normal.
  Its [separable blur](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/tsl/display/depthAwareBlur.js#L39)
  adds two passes, each with five AO and five neighboring-depth samples per pixel,
  plus center depth.
- [GTAO](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/tsl/display/GTAONode.js#L429),
  `samples=16`: three directions × six steps × two sides means 36 neighboring
  depth lookups per pixel, or 8,294,400, plus center gather/normal/noise.
- Both need geometry/prepass work. [TRAA](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/tsl/display/TRAANode.js#L137)
  adds temporal resolve/history operations. These counts do not establish GPU
  duration, bandwidth or performance on Hyperia's actual scene.

The [outdoor SunLight example](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_lights_sunlight.html#L83)
is a more relevant additional reference than automatically copying four-cascade
CSM. Its two-cascade [shadow implementation](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/lights/SunLightShadow.js#L41)
includes rotation-stable fitting, texel snapping, overlap and atlas-border
handling. Two 2048² cascades contain 8,388,608 depth texels; this is capacity,
not a speedup measurement or a proposed fixed budget for every device.

At the earlier cloud-blocked follow-up, safely resident Hyperia `ScatteringSky.ts` and `OutdoorEnvironment.ts` already
contain the atmospheric foundation and twelve precomputed linear PMREM phases
with runtime blending. Do not introduce a second sky/environment owner.
`Environment.ts`, `LightingConfig.ts`, `SkySystem.ts` and
`PostProcessingFactory.ts` were offloaded during this follow-up: their current
activation/composition was not read or inferred from old versions.

The later recovery/capture pass supersedes that availability limitation: all
163 candidate10 source pins rehashed. After separating the equipped capture from
the later coastal scope, the complete capture replay passed 195/195 checks.
Native05 saved all twelve identified two-actor day/night views in the actual
1280×720 WebGPU scene at DPR 1. Its later coastal comparison still failed the
unchanged phase limit; neither run is a complete visual/performance pass.

The identified kit is warm bronze, with pale/cool skin in daylight. At night,
armor and dark cloth lose important detail and separation. The blue figure in
native04's pond view must not be attributed to this kit: the retained camera and
manifest positions strongly support the separate wizard NPC, while the two
equipped actors were behind that camera. This correction is not a general
production-avatar color-bug closure. The next lighting experiment should improve
real world night illumination/material response, preserving the dark sky and
daylight appearance; reject emissive armor, private actor lights or a blanket
exposure lift as substitutes for coherent lighting.

The opt-in RGB sky calibration candidate is now implemented; independent
numerical quadrature checks report less than 1% RGB error. Native06 now adds
all twelve identified day/night views: all six day views show warmer, less-cyan
skin and coherent bronze; all six night views still lose important detail.
Retain this opt-in candidate, without promoting the default. Body/gear materials
and 25 common model pins are unchanged. Dark bronze at night remains a separate
material-authoring question, not a reason for a global exposure lift.

Native05 records shared untextured bronze at scene-linear RGB
`(.22, .108, .046)`, metalness `.83`, roughness `.42`; its authored source is
[build_platebody.py](../../asset-studio/equipment-production-v1/armor-torso/build_platebody.py).
The baked torso uses the exact triangle/UV/material ownership captured by
[prepare_material_repair_07.py](../../asset-studio/equipment-production-v1/armor-torso/prepare_material_repair_07.py)
and the separate coverage repair in
[rasterize_material_repair_07.py](../../asset-studio/equipment-production-v1/armor-torso/rasterize_material_repair_07.py),
then the combined-source export in
[export_torso09_8c.py](../../asset-studio/equipment-production-v1/armor-torso/game-test-export01/export_torso09_8c.py).
The helmet's component-isolated
[bake_trial.py](../../asset-studio/anatomical-adventurer-v1/helmet-redesign-v2/export-work/bake_trial.py)
feeds the preserved baked03 input of
[export_helmet03.py](../../asset-studio/equipment-production-v1/helmet/game-test-export01/export_helmet03.py).

White baked-material factors do not make the whole atlas metallic: linear ORM
separates metal from dielectric lining, while unused black padding is not a
rendered conductor. No new surface-weighted texture statistics were measured.
Before choosing a candidate, measure base color on actual UV-owned metal
surfaces separately from leather, cloth, padding and ambiguous filtering edges.
[glTF defines metallic base color as normal-incidence reflectance](https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/Specification.adoc#metallic-roughness-material);
base-color textures are sRGB, factors are linear and ORM is linear.
[Filament's conductor reference values](https://google.github.io/filament/main/materials.html#materialmodels/standardmodel/basecolor)
are a useful physical reference, not an approved Hyperia bronze palette.

The next nondestructive asset experiment is one consistent **metal-only
base-color palette candidate**, applied to both scalar metal roles and their
UV-owned baked islands. Preserve dielectric pixels, alpha, ORM, normals,
geometry, UVs, rigs, weights and attachment data; reject whole-atlas brightening
or lower metalness as a brightness shortcut. Follow the existing
[shared-model metal-variant policy](../../asset-studio/equipment-production-v1/METAL_VARIANT_POLICY.md):
retain every tier identity and shared geometry, with isolated color bindings.
Current palette work is not an approved armor-wide runtime adapter. Require
unchanged-data proofs and matched actual day/night review before adoption.

The saved shoreline still shows repetitive rock coverage; the pond has an overly
uniform grassy surround and mechanical bank transition. These remain concrete
composition/material targets from the references above.
See [current qualification](../../asset-studio/fine-meadow01/QUALIFICATION.md)
and [native06 verified equipped images](../../asset-studio/game-test-integration/southern-meadow-native06/equipped-images-verification.json).

### Bounded adoption order and rejection criteria

1. **Contact AO experiment:** explicit half-resolution, 16-sample SSAO, small
   contact radius; compare off/on with identical AA, exposure, lighting, camera,
   population and drawing-buffer dimensions. Inspect the normal buffer. Reject
   widespread skin/ground dimming, shoreline halos, loss of foliage cutouts or
   exaggerated baked creases. Transparent-water exclusion is not proof of
   correct water/opaque-depth composition.
2. **Near-playable sun shadows:** compare stabilized coverage with the current
   implementation, preserving required offscreen casters. Reject swimming edges,
   cascade bands, detached feet/thin weapons from excess normal bias, or shadows
   that omit actual grass wind and skeletal deformation.
3. **Temporal GTAO only after comparison:** hold resolution and lighting fixed;
   test equipped actors, moving weapons, vegetation, camera cuts and streamed
   geometry. [VelocityNode](https://github.com/mrdoob/three.js/blob/r186/src/nodes/accessors/VelocityNode.js#L159)
   needs correct previous vertex positions—not just object/camera transforms.
   Reject trails, persistent dark footprints, grass smearing and camera-owner
   interference. A static screenshot cannot qualify temporal behavior.

In the follow-up browser review, the official terrain page exposed controls but
remained visually blank; no new terrain visual result or benchmark is claimed.
Rainy Worlds rendered the wooded entry after explicit Headland selection and
reload, but a coastal view/full traversal was not verified. Both temporary tabs
were closed. This does not replace the earlier limited visual observations.

## Additional independently located references

- [Bruno Simon's folio 2025](https://github.com/brunosimon/folio-2025): a particularly useful whole-world composition/coordination reference, with source for grass, weather, water and instanced objects. [Grass source](https://github.com/brunosimon/folio-2025/blob/main/sources/Game/World/Grass.js), [MIT code license](https://github.com/brunosimon/folio-2025/blob/main/license.md). Its night scene was viewed live in the preceding reference pass. Preserve our preferred fine-blade appearance and check assets separately.
- [Norio's Three.js TSL water](https://github.com/norio/three-stylized-water): inspect modular [depth](https://github.com/norio/three-stylized-water/blob/main/src/water/nodes/depth.ts) and [foreground-safe refraction](https://github.com/norio/three-stylized-water/blob/main/src/water/nodes/refraction.ts). The [README](https://github.com/norio/three-stylized-water/blob/main/README.md) identifies its original Unity shader and MIT provenance. Verify that upstream chain before reuse; start with the relevant depth rules rather than importing the complete reflection/caustic/postprocessing stack.
- [Al-Ro grass](https://al-ro.github.io/projects/grass/), [source](https://github.com/al-ro/al-ro.github.io/blob/master/projects/grass/grass.js): blade variation, rooted wind and translucency reference. Legacy WebGL, not TSL; no reuse license verified. Its configured instance count is not measured performance, and random placement is not a replacement for our deterministic admission.

## Adoption checklist

- [x] Catalogue the supplied references and available source; distinguish current deployments from older repositories and demos from whole-game evidence.
- [x] Identify concrete Hyperia targets and source/license/cost caveats rather than treating popularity or screenshots as acceptance.
- [x] Restore current source availability: candidate12 passes 1,152/1,152, types/builds and 175 unchanged pins; capture Replay09 passes 198/198. This does not certify a workspace relocation or perpetual iCloud residency.
- [x] Capture and inspect all twelve identified day/night kit views independently of the coastal scope. Identity, image bytes and individual fog brackets are verified; this is baseline evidence, not art, motion, fit or performance acceptance.
- [ ] Complete the coastal capture and improve night kit readability. Native06 saves all five coastal PNGs but fails the lowland HUD gate (467.7 ms > 450 ms; restoration after=null); its earlier four HUD pairs pass. Preserve native05's separate phase/missing-image failure. Native06 day skin improves, but the RGB mode remains opt-in and final character lighting acceptance is open.
- [ ] Apply the composition/terrain/ground/vegetation priorities in bounded, reviewable slices, retaining resource and navigation behavior.
- [ ] Compare lighting/contact and water alternatives in the actual populated scene; retain only visible gains with measured costs.
- [ ] Integrate coordinated weather/audio and spectator presentation without obscuring combat or adding unbounded work.
- [ ] For any copied implementation: pin revision, verify the complete license/provenance chain, retain notices and add appropriate real integration tests.
- [ ] Close visual, gameplay, stream, loading, frame-time, memory and long-duration gates using actual Hyperia evidence. No reference in this document closes those gates by itself.
