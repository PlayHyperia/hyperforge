# World graphics development checkpoint — 2026-09-20

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

## Regional meadow and grass census — 2026-09-22

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





## Pond-bank service ground — 2026-09-22

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

## Compact pond sunlight correction — 2026-09-22

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

## Pond surface, service clearing and woodland comparison — 2026-09-21

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

## Pond timber and gentler-bank study — 2026-09-21

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

## Pond-depth attribution and new art candidates — 2026-09-21

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

## Compact single-map shadow correction — 2026-09-21

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

## Refined face fitting — 2026-09-21 (geometry verified; tails still open)

Conservative interior-face certification preserves every tested geometry buffer
while reducing work 19–25% in six dense shore cases. The newest failed LOD0
cells improve less than1%; do not claim their intermittent failure is fixed.
601 tests,160 exact array hashes,726-root/2,747-source noEmit,lint/format pass.
Metadata adds16,129 bytes/owner at resolution128, exactly reserved; caps unchanged.

Build40/native75 completes original startup38.515s and four camera gates
6.006/2.648/1.772/2.645s with the same camera/render settings and populations
as native73. Main slice max8.6ms/admission4.1ms and multi-second transitions
remain unqualified. Overview exposure fails the unchanged1e-6 matching gate.
All four images reviewed: no AAA or visual-improvement claim.

Native74 startup failure remains retained. Native76 passes startup40.513s but
the first zero-bias A/B state is rejected by the unchanged production profile.
Only the private diagnostic admission is being corrected; no production shadow
change or complete shadow pair. Original camera/clock/bias restored and browser
closed. Next: five-view/three-phase shadow qualification, then shoreline massing
and pavilion arrival. If fitting failures recur, profile the actual worker's
whole-clump envelope before choosing another optimization.

Native77 also stops after a baseline image on a diagnostic frame-stamp check;
no zero-bias pair is captured. Exact last-render/selection-frame validation is
reviewed but not runtime-qualified. Original failures remain retained.
Delivered60-second native4K/30fps island cinematic at the actual in-game2x
setting, with1,800 unique rendered frames. Independent frame/clock/grass,
18 PNG hashes and full decode pass. Normal Chrome playback completes60s:
no corruption/media/page errors; four startup dropped frames, none afterward.
This is offline environment progress, not live gameplay, streaming, startup,
AAA or real-time performance proof. No world edits or quality reductions.
Master: progress-videos/hyperia-island-progress-4k-60s-20260921.mp4.
Capture evidence: progress-videos/island-cinematic-20260921-04/.
All capture browsers/helpers and runtime53/54 disposable databases are closed.
Next: water-tone seam (also visible before offline capture), dock shadows,
shoreline massing and pavilion detail with performance qualification.
Human localhost3333/DB, canonical outputs, lock and unrelated files protected.
Eight mirrors updated. Compact island only, one arena, SOL only; goal active.

## Height-only sampling — 2026-09-21 (native recovery; still unqualified)

The exact native72 cell is now an actual-terrain regression. Conservative reuse
of existing face bounds avoids impossible height-sampling candidates without
changing triangle order, heights, grass coverage, work accounting or limits.
578 focused tests and six real pond cases pass; all 120 A/B array hashes,
provenance data, geometric-work/phase receipts and pipeline operations match.
Final noEmit: 724 roots / 2,745 sources, zero diagnostics; lint/format pass.

Build39/native73 completes startup (44.022 s, 122 grass cells) and all four
original camera gates (6.133/3.244/2.090/3.176 s), with no errors and identical
camera/render settings and populations to native70. This is functional recovery,
not a controlled speedup: power/contention and prior handoff/audio source differ.
Admission max28.2ms and multi-second settling remain open. Overview exposure
differs2.8419e-5 and fails the original1e-6 photometric audit; no relaxed threshold.
Prior native67/72 failures are retained, not erased. No smoothness/stream/AAA claim.

All four images reviewed: dock shadow plaid, bare bank ribbon, sparse planting,
uniform lawn and pavilion arrival remain below target. Next: matched compact-sun
bias qualification at three phases, then larger shoreline planting/rock masses;
continue sustained movement/cache and admission/frame/heap-tail qualification.
No quality/budget reductions or increases, no playable default promotion.

Runtime52/temp DB removed; owned browser closed. Canonical outputs, lock,
localhost:3333/DB and unrelated work remain protected; eight mirrors agree.
World first, compact island only, one arena, SOL only. Goal remains active.

## Bounded grass handoff and native audio — 2026-09-21 (unqualified fitting)

The worker candidate now retains bounded terminal admission evidence and groups
positive-progress local handoff phases within the existing 2 ms / 8,192-operation
manager allowance. No fitting limits, terrain/grass quality or default is changed.
157 worker/manager regressions pass; no native speed improvement is established.

Ordinary audio unlock no longer depends on missing /tiny.mp4. Four actual
Chrome/Metal gesture/lifecycle tests pass, including duplicate inputs, closed or
destroyed contexts, and a native callback error. Callback failure stays distinct
from failed resume; old abort-on-callback-error queue behavior remains unchanged.
Full shared/test noEmit, scoped lint/format and nine isolated build38 bundles pass.
Build38 adds callback-error containment after world-tested build37, not a new
full-world capture; audible content, Safari and stream qualification stay open.

Native69 profiles two original cuts, but the earlier 144.3 ms admission spike
does not recur and is not marked fixed. Native70/build35 is the four-view
baseline (73.428 s startup, 21.934/6.268/5.129/8.231 s cuts). Native71 fails on
the audio issue. Native72/build37 instead FAILS the original 90 s startup gate:
gcell_v1_15_17 LOD1 fitting reaches 251.700 ms / 153,028 operations under the
unchanged 250 ms cap. Zero views; no audio-unlock errors; admission failure is
null. Neither shorter failed-run startup nor test passes qualify smoothness.

Next: exact failed-cell regression and conservative height-sampling optimization
with mathematical/output/work parity, then paired real-worker/native checks.
After reliable capture, return to shadow-bias qualification, larger shoreline
plant/rock masses, pavilion arrival and island composition. Current art remains
below target; no density/resolution/shadow cuts or cap/deadline increases.

Owned runtime48–51/databases and native68–72 browsers are closed. Canonical
outputs, lock, human localhost:3333/DB and unrelated work remain protected.
Eight checklist/status mirrors agree. Goal active; no default promotion,
merge, deploy or dependency installation.

## Shore-family study — 2026-09-21 (unqualified; native admission failure)

Dry-turf toes retain their original material family instead of receiving the
cutbank mineral grade. This is a small candidate correction, not a meaningful
shoreline-quality milestone. Native67's single usable overview is too subtle
for visual approval; the bare rim, sparse planting and uniform lawn remain.

159 material tests, final nine-case substrate run, full shared/test noEmit and
lint pass. Archived/current factory comparison preserves coverage and wetness
across 7,200 samples. Four completed grass cases retain 74 hashes and change
only six ground-color hashes; the fifth legacy full pipeline fails its original
250 ms CPU cap. No budget, quality or timeout is relaxed.

Build34/native67 passes startup and overview, then FAILS landing grass-cache
admission before fitting. First job gcell_v1_16_19; two further failures follow.
Do not report four views, smoothness, streaming, AAA or production approval.
Next priority: retain exact failing admission-owner/cost evidence and fix that
bounded work; then whole-scene shadow-bias qualification and larger shoreline
plant/rock massing. Dock plaid is an established shadow artifact, not a new
wood-texture hypothesis. Reuse the recorded primary Three.js references.

Runtime47 and its temporary database are removed; owned browser closed;
localhost:3333/DB, canonical builds and unrelated work stay protected.
Goal remains active. No default promotion, merge, deploy or dependency installs.

## Grass worker world ownership checkpoint — 2026-09-21

The candidate is now connected to actual TerrainSystem/GrassVisualManager behind
the explicit `grassGrounding=worker-v1` selector. Ordinary defaults and your
playable localhost:3333 artifacts are unchanged. One copied handoff, bounded
held-surface cache, original cumulative fitting limits, cancellation/version/
region guards and one mesh upload/frame are preserved. Worker failure cleanup
now releases the actual active owner even when a dormant job notices death first.

747 regressions and 205 focused tests (overlap), ten actual factory/Vite/native
Chrome-Metal cases, full shared/tests/Vite noEmit (720 roots/2,738 sources) and
scoped lint pass. The actual staged-dev-batch function was exercised with real
esbuild, disk and Chokidar: failed/stale compilation leaves prior outputs intact;
successful final client commit sees matching worker/full outputs. Complete
long-running development/HMR lifecycle remains unqualified.

Isolated build32/native65 captured four pond views with all 122 grass cells ready,
no errors, 51.066 s startup and 17.972/5.267/4.316/6.646 s camera settling. This is
functional capture, not smoothness/performance/streaming/AAA approval.
Native64's earlier diagnostic-method failure remains retained, not erased.
Final exact post-review build33/native66 also captures all four views with no
errors: startup 47.250 s / 122 cells; cuts 16.824/5.274/4.296/6.825 s, under the
unchanged 90 s startup / 30 s cut limits. Main grounding slice maximum 2.4 ms;
separate admission maximum 7.5 ms. This remains an unqualified smoothness result:
camera settling still takes seconds. Native65's 16.7 ms admission tail remains
recorded; remote/main costs must not be conflated or selectively discarded.

Owned runtime45/46 stopped and temporary databases were removed; owned browsers
closed. All 145 canonical output hashes, five unchanged build-input pins,
retained lock and human localhost:3333/DB identities are protected. Only the
build-script source pin was explicitly admitted for emitting the worker.
All eight mirrored status sections agree. Source remains opt-in; no merge/deploy.

Next: sustained movement/LOD/cache retirement, main/remote CPU attribution and
whole-heap/frame/upload tails, then matched shoreline planting, less uniform
grass, dock timber, pavilion arrival and island composition. Current images still
do not meet the intended art bar. No density/resolution/shadow cuts, cap increases,
default promotion, human DB changes, installs or dependency upgrades.

## Grass fitting handoff and native transport — 2026-09-21

Source candidate only: bounded main projection/copy, single-slot worker client
and held-owner/provenance publication are implemented and verified. **346 tests
pass**, including all five actual pond jobs within the original cumulative
250 ms / 1m budget and ten actual headful Chrome/Metal browser transport checks.
Full shared + nine changed/test roots typecheck: 716 roots / 2,490 sources, zero
diagnostics. All 100 baseline pond hashes remain exact. Detailed results and
references are mirrored in the launch checklist/art/reference/asset ledgers.

Near-south full fitting+transport+publication measured 218.667 ms; first native
cold dispatch 2.935 / 5.175 ms exceeds the cooperative 2 ms target and stays OPEN.
These are CPU/transport observations, not native world/startup/frame acceptance.
Actual game-manager source-cache lifecycle, pre-copy aggregate reservations,
worker bundle/watch integration, unchanged camera gates and full memory/perf
qualification remain next. Native63 remains the last failed original camera
gate; no default promotion or new visual/AAA/launch approval.

Evidence: service-layout grounding-handoff-*; failed initial test-type checks are
retained, corrected types05 is clean. Owned browser/worker/server resources close;
human localhost:3333 and protected artifacts/build inputs/lock remain untouched.
World first: after runtime integration, return to pond materials/planting, pavilion
arrival/docks, island composition and other open art gates.

## Exact-fitting worker and bounded retained-terrain reuse — 2026-09-21

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

## Pond material families and frame-coupled grass loading — 2026-09-21

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

## Finer terrain lookup and bank drift — native startup still open — 2026-09-21

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


## Paired shore and timber candidate — loading gates still open — 2026-09-21

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

## Pond substrate trial rejected; cutbank coverage retained — 2026-09-21

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

## Exact two-interval grass ordering — 2026-09-21

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

## Startup grass throughput traced on both pond candidates — 2026-09-21

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

## Eastern shelf groundcover trial and startup variability — 2026-09-21

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

## Asymmetric pond headland and retained fishing capacity — 2026-09-21

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

## Pond world-art capture and bounded dock chamfers — 2026-09-21

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

## Indexed grass edge batching and repeated native pond gates — 2026-09-21

Four bounded indexed cursor steps now share a generator suspension. Geometry,
triangle order, per-step work charges and owner checks are preserved; generic
fallback is unchanged. No added cache or quality/budget reduction. Clock checks
can span 256 indexed steps instead of 64; the 2ms slice remains cooperative.

Real southern cell: 931/970 retained, 39 water rejects, 347,209 triangle visits,
46,560 endpoint queries and 912,895 work units unchanged. Resumptions reduce
709,023→361,585, full CPU active 184.827ms→157.587/156.713ms, output hash unchanged.
The larger four-face index and slower shared-clump experiments were rejected.
The real-asset oracle now checks complete semantic receipts as well as arrays.

405/405 broad regression, 103/103 same-face tests with 31 new dense indexed cases;
both actual pond fixtures pass. Types: 707 roots / 2,382 files / zero diagnostics,
stable pins. Scoped lint/format and independent read-only review pass.
Build23 emits eight private bundles from 973 stable inputs.

Native43/44 pass original startup and the first three grass camera gates without
observed grounding failures: overview 26.760/24.503s, landing 10.438/10.120s,
jetty 4.515/3.924s. These are not seamless transitions or FPS acceptance.
Existing startup maximum slices remain 18.7/11.4ms. Both terminal runs FAIL:
native43 sees the 120s boot overlay; native44 catches HUD root identity changing
during third-image restoration at that timeout. No fourth view in either run.
The world fixture disables streaming duels, reports waiting_for_duel_data and
cannot satisfy real stream admission. Preserve these failures; separate world
capture from stream admission or use actual no-money duel data, never fake
readiness or suppress the timeout. No production stream regression is established.

All fourteen fish entities reach both clients. Keep seven families/twelve fish,
fourteen anglers plus overflow, dry access at every tier and two distinct docks.
Visuals still need a natural shore, richer bank habitats and characterful docks;
actual fishing/banking/navigation, GPU retirement and sustained pacing remain open.
Both browsers and runtime26's ephemeral database are closed. Human localhost,
protected artifacts and build inputs remain unchanged; eight mirrors match.
All LAYOUT-01–08 open. No default promotion, merge, deploy or AAA approval.

Evidence: service-layout pond-south-edge-before01, pond-south-batch01–02,
pond-edge-batch-review52-01/regression01/sameface01/types02/lint02/format02;
inland pond build23/runtime26/native43–44.

## Primary vegetation storage and native shadow attribution — 2026-09-21

Primary vegetation chunks now reuse the existing versioned storage matrix helper,
including the same lifetime registration on hero/borrowed LOD geometries. Ordinary
population/finalization remains unchanged; no geometry, density, transforms, wind,
material, shadow, camera/LOD criterion or readiness budget is reduced. Separate
legacy LOD1/LOD2 constructors are untouched.

Final regression: 287/287 across seven suites. Full shared production plus explicit
affected tests: 707 roots / 2,382 source files / zero diagnostics and stable pins.
Scoped lint/format pass. The initial test-inclusive seven union-type errors are
retained in types01 and fixed through actual material narrowing/concrete listeners,
not casts or mocks. CPU dispose events are not actual GPU reclamation evidence.
Build22 emits eight isolated bundles from 973 stable inputs.

Native39's incomplete metadata receipt is retained (676 truncated uniform fields);
native40's complete observation identifies 156 actual mushroom matrix BufferNode
writes, 16,384 bytes each, in 13 sampled frames. Versions change during loading,
so not all baseline writes are redundant. Native40 also reproduces the southern
grass job active CPU failure at 250.400ms / 673,792 operations.

Native41 observes zero mushroom matrix writes via binding or attribute routes in
30 sampled frames, with complete same-frame/pass correlation and no GPU/observer
errors. All 18 primary chunks have storage/geometry registration; eight existing
GPU allocations are observed, six chunks visible at the final view. This is a
bounded sampled result, not proof that future dirty updates never occur.

Overall readiness is NOT fixed. Native41 misses the thirty-second gate with five
LOD jobs still running. Dominant queue-call residency shifts to an ocean uniform:
90 tiny writes / 720 total bytes / 733.800ms residence. Matched-frame medians:
CPU render46.0ms, native GPU envelope92.209ms. Intervals overlap; no exclusive
GPU-cost or throughput improvement is established. Native42 uninstrumented fails
the same southern grass job at250.400ms /708,224 operations,18.323s after the cut.
No time/work limit is raised; later views do not run. Startup passes in all four
runs and all fourteen fishing entities reach each actual client.

The actual scene still fails the art bar: oval pond, continuous shore collar,
sparse bank detail and plain dock/outpost composition. Keep seven families/twelve
fish, fourteen anglers plus overflow, dry shore access and two distinct docks.
Next: reduce exact south-bank grounding work with output parity, distinguish
render/backpressure cause from its blocking write site, then repeat native gates
and complete shore/dock/fishing gameplay and actual GPU retirement checks.

Owned native39–42 browsers and runtime24/25 temporary databases are closed.
Protected human localhost/database,145 compiled artifacts,six build inputs and
retained lock remain unchanged. Eight common mirrors match. All LAYOUT-01–08 open;
no candidate default promotion, merge, deployment or AAA/performance approval.

Evidence: service-layout pond-vegetation-storage01–02,types01–02,lint01,format01;
inland pond build21/runtime24/native39–40,build22/runtime25/native41–42 and
native41/SHADOW_BUFFER_REVIEW.md.

## Pond grounding parity and shadow-cost attribution — 2026-09-21

The exact southern pond cell now has a real-worker/retained-terrain regression.
The height/face-only sampler skips unused endpoint normals while keeping full
anchor normals and the original indexed sampling math. Before/after retain
931 of 970 clumps, reject 39 at water, and preserve 912,895 geometric work units,
709,023 continuation resumptions and the independent legacy output comparisons.
The output hash stays af12d68c1875e5b95cf880f26df31fe48ca76452cfe4cb11c904cfaff00ed91d.
CPU readings of 179.688ms before and 177.620/185.319ms after do not establish a
repeatable overall speed gain.

Final targeted suite: 59 passed / one alternate-overlay skip. Broad grass suite:
419/419. Original review52 real-asset case also passes. Full shared source plus
explicit changed tests: 707 roots / 2,382 sources, zero diagnostics, stable pins.
Scoped lint/format pass. The initial fixture tuple-inference type error remains
recorded and was fixed with an explicit readonly tuple annotation.

Build21 emits eight isolated bundles from 973 stable inputs. Native37 passes
startup but misses the unchanged thirty-second pond-overview camera gate:
three LOD1 jobs remain running, two with zero work. The earlier per-cell CPU
failure does not recur in that run, but this is still a failed readiness result.
Native38's CPU-only trace settles in 29.352s, only 0.648s inside the limit.
That instrumented result does not erase native37 or qualify reliable readiness.

The 30.3497s profile contains 23,639 valid samples. Exact grounding ancestry
accounts for 1.048078s (3.45%) of sampled deltas. Native writeBuffer accounts for
15.969750s (52.62%), of which 15.226129s is in shadow uniform-buffer updates.
Native getCurrentTexture accounts for 3.664026s. These may include native
synchronization/backpressure; they are not GPU execution timings or proof
of excessive uploaded bytes. The next bounded investigation is exact shadow
uniform-buffer owners, write sizes/ranges/frequency and correlated GPU pass cost.
Do not lower shadow quality, density or resolution, or raise time/work limits.

All fourteen fishing entities reach the real client. All seven families/twelve
fish, fourteen simultaneous anglers plus safe overflow, shore access at each
tier and two distinct docks remain integrated acceptance requirements. Actual
stills still show an overly uniform shore ring and insufficient bank character.
Natural pond/dock/outpost art, native fishing/banking/restart and sustained
whole-island performance remain open. No default promotion or AAA approval.

Both test browsers, runtime23 and its ephemeral database are closed. Protected
human localhost/database, 145 compiled artifacts, six build inputs and retained
lock are unchanged. Eight common status mirrors match. No avatar, placement,
fish, dock, material, wind or shadow setting changes. All LAYOUT-01–08 stay open.

Evidence: service-layout pond-south-grounding-before01,
pond-south-height-sampler01–02, pond-height-regression01,
pond-height-review52-regression01–02, pond-height-types01–02 (final02),
pond-height-lint01–02 / format01; inland pond build21/runtime23/native37–38
and native38/CPU_PROFILE_REVIEW.md. Earlier failures are retained.

## Pond outpost art and full fishing scope — 2026-09-21

The pond remains sized/planned for all seven fishing families, twelve fish,
fourteen simultaneous anglers with safe overflow, non-dock access at every tier
and two distinct procedural docks. This checkpoint does not close that gameplay
or art acceptance. No basin, resource, water level or terrain grade is moved.

Implemented an explicitly bound outpost connector, chest/clerk service wear and
unequal activity patch using the existing shared terrain/grass field. Historical
primary paths remain exact. The baseline test adds 51 segments, 501 total,
and proves 270 actual worker/terrain field agreements. Sampled filtered dock
bleed is unchanged (historical maximum 0.178611); wet samples remain zero.
This is not full native candidate halo or grass-root-density qualification.

The separate pond pavilion has a lower 22-degree open roof, extended lakeward
timber and one north-facing service plaque. It uses 1,396 triangles, 231,888
attribute bytes and three private material batches. Town geometry remains
1,492 triangles / 247,200 bytes. Physical/visual owners share one recipe mapping;
fixed foot/post positions, open passages and per-court cutaway ownership remain.
Streaming readiness validates exact recipe/counts, not just a generic budget.

Tests: final path/worker/owner/native-PhysX/visual suite 69/69; procgen 15/15;
existing client diagnostics 21/21. Full shared source plus explicit changed tests
and readiness typing: 709 roots / 2,384 sources / zero diagnostics, stable pins.
Scoped lint and formatting pass. Earlier fixture/type/compiled-alias failures
remain retained. Build20 produces eight bundles from 973 stable source inputs.

Native35 real Chrome/Metal at 1280x720 passes the ninety-second startup gate,
then fails the first pond overview: grass cell gcell_v1_16_17, x400..425/z425..450,
LOD0, exceeds the existing 250ms cumulative active CPU gate at251.9ms and646,144
operations. This is not a thirty-second observation timeout. Native36's separate
close art diagnostic misses ninety-second startup, then its post-failure camera
settles in12.113s. Neither result is performance acceptance; no budget is raised,
density/resolution reduced, or failure erased. Actual stills show modest roof/
wear improvement but insufficient landscape character and a continuous shore
collar. AAA art approval remains explicitly absent.

Detached assets-v7 changes only haven-pond-bank-v1's recipe; assets-v6 and
canonical manifests remain intact. Owned browser35/browser36/runtime22 and its
ephemeral database are closed. All145 protected compiled artifacts, package
inputs/retained lock and human localhost remain unchanged. Eight mirrors match.

Next: instrument/profile the exact southern-bank grounding work and preserve
output parity while reducing cost; repeat startup/transition gates, then improve
natural bank/dock composition and integrated all-tier fishing gameplay.
All LAYOUT-01–08 remain open; no default promotion, merge or deployment.

Evidence: service-layout pond-outpost-wear05, pond-bank-recipe-tests01,
pond-outpost-client-regression01, pond-outpost-types03, pond-outpost-lint01;
inland pond build20/runtime22/native35/native36. Earlier failures retained.

## Fishing stance circulation — deterministic prevention, capacity sampled

The recorded three-angler trap now has a failing-before/passing-after real-owner
regression. New fishing stances must preserve canonical adjacent exits for the
candidate, nearby real player occupants and pending approach reservations.
Diagonal supports use the same movement rules. No collision mutation, route-only
walking restriction, forced human movement or extra path search is introduced.
Actual occupancy retains protection after gathering stops until departure.

Arrival checks again and may choose another shore under the same attempt and
deadline. ResourceSystem enforces final new-session admission using the actual
server player tile, covering direct callers too. Its exclusive validator lease
is identity-safe and remains required across retirement/rebind; network teardown
releases pending gathering before movement. Existing sessions and non-fishing
unbound event behavior are unchanged. This is local prevention, not global
connectivity or recovery from arbitrary later human obstruction.

Six deterministic actual-owner cases pass. Candidate02 passes 40 / one capacity
skip; canonical regression02 passes 68 / 23 opt-in skips. The route matrix
completes 32 roundtrips (64 legs), sixteen paired comparisons from ten distinct
starts: 1,691 town ticks versus 508 pond-bank ticks in this arrangement. These
are sequential CPU measurements, not throughput or FPS comparisons.

One separately selected unchanged capacity case passes fourteen anglers plus
seven accepted extras, twenty-one distinct supported positions, actual owner
re-entry and recovery of two anglers after actual fish relocation. Every phase
passes its unchanged twenty-tick bound; exact tick counts are not logged.
The capacity fixture lacks the dock/court/rock physics owners present in the
separate route fixture. It does not prove all twelve rewards, persistence,
socket lifecycle, autonomous yielding, native crowd gameplay, exhaustive
pockets/random arrangements or sustained performance.

The initial canonical/candidate suites found the old exact-four-metre fixture
used trapped players to isolate range. It now uses scoped real static collision
leases, preserving exact range/support/session checks and proving an outward
exit. Failed receipts remain. The capacity test body is unchanged from HEAD.

Shared resource regressions pass 34/34; shared full-source typing covers 707
roots / 2,382 sources and server test-inclusive typing 3,954 sources, all zero
diagnostics with stable pins. Scoped lint/format and independent source/test
review pass. Local admission work is bounded but not many-agent cost-qualified.

Build19 emits eight isolated bundles from 973 stable inputs. Native34 boots
actual Chrome/Metal WebGPU at unchanged 1280×720, passes the ninety-second
startup gate, and settles the outpost still in 9.84s under the thirty-second
gate. This is boot/art evidence, not rendered fishing interaction or performance.
The outpost remains visually rejected: excessive grass, missing worn connector,
repeated pavilion character. Isolated stream-state 503s and the known unmodeled
mob 404 remain recorded.

Owned browser34/runtime21 and its ephemeral database are closed. Protected
localhost/game database, all 145 compiled artifacts and package/build inputs
remain unchanged. No candidate default is promoted or quality budget reduced.

Next: repeat/extend circulation and autonomous recovery qualification; compose
the worn outpost arrival and distinct pavilion character, then native gameplay,
rewards/banking authority, startup reliability and sustained whole-island cost.
Keep LAYOUT-01–08 open.

Evidence: service-layout pond-egress-admission-before01/after01/candidate01–02/
regression01–02/types02/lint02/format03, pond-egress-capacity-v6-01,
pond-egress-resource-regression01/shared-types01/root-eslint01 and
fishing-stance-pending-eslint02; inland pond build19, runtime21 and native34.

## Bounded pond-route recovery — tested source checkpoint

The valid pond return routes no longer fail merely because one 250-iteration
search slice ends without a useful segment. Explicit pending/found/exhausted
results retain each stationary actor's private frontier between ticks, with
unchanged 250/search-slice and 1,000/tick limits, radius and route deadlines. Useful
segments still publish immediately. Relevant collision changes invalidate
retained work; distant changes do not. Same-tick terrain/directional caches,
repeated intents, cancellation, synchronization, missing entities and network
teardown now have owner-safe cleanup and actual-class regression coverage.
Upper-floor topology remains on its historical one-shot search path.

This supersedes the earlier incomplete CPU route result below, not the
separate crowd-trapping or art rejection. Two exact stranded cases arrive in
13/16 logical ticks. Final candidate02 completes 32/32 roundtrips (64 legs),
sixteen paired comparisons from ten distinct physical starts; town trips total
1,623 ticks versus 591 for the pond bank in this arrangement. All seven
non-dock family witnesses pass actual gathering admission. Dock roundtrips
prove access, not fishing from each deck. Fourteen resources/twelve drop IDs
do not prove fourteen simultaneous fishers or all twelve rewards caught.

Verification on frozen production: shared movement 397/397; candidate server
34 passed / one known capacity skip; canonical server 68 passed / seventeen
opt-in skips. Shared test-inclusive typing covers 707 roots / 2,382 sources;
server typing covers 3,954 sources, both zero diagnostics with stable pins.
Scoped lint/format and independent review pass. Cache failures were reproduced
before correction; superseded fixture/assertion/type-harness failures are
retained. The five-player budget test proves saturation/defer behavior, not
concurrent arrival or frame performance.

Final isolated build18 emits eight bundles from 973 stable production inputs.
Native33 boots actual Chrome/Metal WebGPU at unchanged 1280×720, passes the
original 90-second startup gate and settles the outpost capture in 10.88s under
the original 30-second transition limit. It is a diagnostic still, not native
route/gathering or sustained performance proof; earlier failed startup and
transition receipts remain open reliability evidence. Visual review still
rejects excessive court grass, missing worn arrival/connector and repeated
pavilion character. Streaming-state 503s and the known unmodeled mob 404 are
recorded, not presented as a clean full-stream runtime.

Private runtime20 and owned browser33 are closed; the ephemeral database is
removed. Protected localhost/game database, all 145 compiled artifacts, six
build inputs and the retained package lock are unchanged. No candidate default
is promoted and no shader, density, resolution or quality budget is reduced.

Next: preserve legal escape space throughout active fishing/departure, then
prove fourteen anglers plus overflow and relocation without moving human
players or relaxing collision. Follow with native gameplay, outpost/dock/shore
art, bank authority/transport/restart and repeated startup/sustained performance.
All LAYOUT-01–08 remain open.

Evidence: service-layout pond-stranded-route-before01,
pond-route-cache-before01/candidate02/regression02/types02/lint02/format04,
guided-resume-tests02/shared-regression01/shared-types01;
inland pond build17 (superseded), build18, runtime20 and native33. The mirrored
launch checklist contains the full scope, primary technique references and
acceptance boundaries.

## Secondary pond bank, bank discovery and retained-ground alignment

The pond capacity requirement remains seven fishing families / twelve fish,
fourteen simultaneous anglers plus overflow, non-dock shore access at every
tier, and two visually distinct procedural docks. Keep LAYOUT-01–08 open.

Fixed a reproduced nearest-bank discovery bug in agent deposit-all: a bank
selected during the search no longer filters out later, nearer banks. Only an
explicit requested ID filters discovery. The real World/player/BankEntity/
inventory/PostgreSQL regression fails before and passes after; final 16/16
custody cases pass. It proves shared player balance across two physical bank
fixtures, withdrawal, exact-ID/range rejection and replay without a second debit.
It is not final-layout transport, concurrency or restart acceptance. Existing
agent-bank regressions pass 43/43. Legacy in-memory banking/event consumers
remain a single-authority audit gap.

The candidate fixture adds a second bank court at (384,438), chest (382,436),
clerk (386,440), informed by fifteen actual-owner site probes. Detached assets-v6
includes its registered clerk; v5's missing NPC catalogue entry is corrected
and its failed evidence retained. No live/default manifest is promoted.

The new station blend exposed a 27.541mm indexed-ground mismatch. Plural bank
courts now reuse existing bounded collar refinement around loaded station pads;
historical singular behavior, height rules, resolution and all caps stay intact.
The witness drops to 0.000575mm; 6,561 bank-envelope probes stay within
0.462349mm and 36 footing probes within 0.098293mm. The affected terrain leaf
adds 1,144 vertices / 2,288 triangles / 91,520 geometry bytes. These are sampled
geometry measurements, not sustained frame-performance approval.

At this earlier checkpoint, route evidence FAILED. V6-04 completes fourteen
same-start bank comparisons: 457 total pond-bank ticks versus 1,473 town ticks. Two town returns
fail and their pond comparisons are skipped. Final v6-05 records 28 journeys,
24 complete and four failed town returns at the two known shore destinations;
only twelve comparisons complete. A one-bank v4 control reproduces the bounded
search failure too. Exact movement can stop after a 250-iteration partial search
despite an available destination. All seven non-dock witnesses pass, but this
is not complete 64-leg acceptance. A separate crowded relocation leaves an
angler enclosed by water and occupied cardinal tiles. Do not increase budgets,
allow illegal diagonal corner cuts, teleport or hide failures with later passes.

Native30 fails the original 30-second overview grass-transition gate.
Native31/32 capture the actual outpost at matched camera placement, unchanged
1280×720 Chrome/Metal quality. Arrival settling takes 11.78s / 9.56s respectively,
but native32 fails the original 90-second startup gate and is art-inspection
only. Both views are rejected for final art: excessive grass in the court,
missing worn arrival/connector and a repeated town-bank silhouette.
No AAA, sustained performance or streaming acceptance is claimed.

Final gates: canonical server 68 passed / two intentional candidate skips;
stock shared geometry/profile/water 78 passed / three candidate skips;
focused v6 retained surface 2/2; historical singular/shoulder/seam controls 3/3.
Shared typing covers 732 roots and server typing 3,954 program sources, zero
diagnostics and stable pins. Banking's focused type check also passes. Scoped
lint/formatting and independent review pass. Earlier fixture/import/hash errors
and incompatible whole-overlay attempts remain recorded, not counted as passes.

Build15/16 each emit eight isolated bundles from 973 stable production inputs.
All 145 protected artifacts remain intact. Private runtimes 16–19 and browsers
30–32 are closed, with owned ephemeral databases removed; human localhost and
its database remain untouched. No shader, density or quality-budget reduction.

Next: retain/resume bounded detour search; preserve crowd escape space and
coordinate yielding; compose the outpost arrival/planting/character; qualify
bank authority/transport and whole-layout routes, then startup and native art/
sustained performance. Do not promote the candidate before these gates pass.

Evidence: service-layout two-bank-custody-before02/after01/regression01/types02;
pond-outlying-bank-sites03; pond-secondary-bank-candidate-v6-04/05,
regression02/types02/format04/lint03; bank-collar-before01,
stock-regression02/v6-actual-final01/singular52-final01/types-final01/
eslint-final01; inland pond assets-v5/v6, build15/16, runtime16–19, native30–32.


## Ground-item boundaries, PostgreSQL custody and pond-bank journeys

Fixed a reproduced historical tile-snap boundary defect: a source requested
outside protection at z=348.49 could be planned at protected z=348.5. Single,
batch and direct-spawn paths now validate the final grounded position before
returning a durable plan or performing persistence/merge/presentation. The
actual compact protection geometry and all economic rules are unchanged.

Four new actual World/Terrain/EntityManager source-planning cases cover 36
facility-edge samples and the legacy snap witness; these plus 19 existing
regressions pass. The canonical shared gate passes 162 cases with four
intentional candidate-only skips. Shared source-aware typing passes 732 roots,
zero diagnostics. Independent review found no remaining production blocker.

The final real PostgreSQL run passes 15/15, joining actual grounded item/arrow
source plans to fully migrated custody transactions at dry pond and ordinary
grounds points. All three protected facilities reject source planning and
recoverable ammunition with no debit/receipt/source. Fresh owners/pools replay
exact quantities and coordinates without a second debit. The existing
safe-death outage/recovery case passes too, but it is not a new pond
death-handler, grave, socket, projectile-flight or caught-fish reward test.

The candidate route test instantiates real terrain, generated/authored
resources, all eleven manifest NPCs, stations, arena walls and native CPU
PhysX dock/court/rock owners. Both decks, seven family approaches and seven
verified non-dock approaches complete sixteen round trips / thirty-two legs;
every bank arrival passes actual station_bank_spawn physical authorization.
In the final candidate05 arrangement, legs take 39–64 logical ticks,
not wall-clock or FPS measurements. All sampled end-step static flags and
root support checks pass. The painted-width capsule avoids all protection
aprons exactly; 34,432 perimeter samples find no pond water.

Free movement crosses traversable lobby/hospital floors on 21/32 observed
legs. That is design evidence, not justification for invisible walls,
road-only movement or immunity exceptions. Only one bank exists in this
candidate; a composed secondary bank and shorter preparation journeys remain
LAYOUT-02 work. Bank transfers, simultaneous traffic, dynamic mobs, physical
stepping, rendered crowds and all randomized arrangements are not qualified.

Full candidate tests pass 20/20 through the checked-in server config's explicit
route mode (actual source/PhysX resolution, unchanged normal test mode).
Canonical server regressions pass 68 with two
intentional candidate skips. Server source typing covers 3,954 transitive
sources with zero diagnostics/stable pins; scoped lint/formatting pass.
Build14 emits eight isolated bundles from 973 stable production inputs and
preserves 145 protected artifacts. No default manifest, served build or
graphics-quality setting is promoted. Human localhost/database remain intact.

Evidence: service-layout shore-source-before02/after02/regression02/types02,
facility-custody-pg01–04, pond-bank-routes-candidate-v4-01–05,
pond-bank-routes-regression02/types01; inland pond isolated-build14-report.
Failed setup receipts remain. All temporary PostgreSQL containers are removed,
including a deliberate nonzero-child cleanup check. Keep LAYOUT-01–08 open.

## Facility protection and all-tier fishing capacity checkpoint

Implemented an opt-in `facility-floors-v1` protection contract: actual ring,
lobby and hospital floors plus their existing one-metre apron, not the broad
rectangle around them. Shared death/drop/ammunition/resource consumers use
this predicate. Client/server lobby challenges share actual lobby-floor
eligibility; queued callbacks recheck both participants. Zone membership,
overlap priority and cache edges now follow the three component rectangles.

Malformed metadata fails manifest admission before readiness, even with
SKIP_VALIDATION. Unmarked manifests retain their historical behavior. Only
detached assets-v4 opts in, with explicit ordinary safe grounds between the
facilities and lower-edge shoulders preserving historical boundary tile
centers. No live/default manifest, compiled human output or lighting default
was promoted. Assets-v3 remains the rejected exclusive-minimum-edge study.

The new actual-owner capacity test covers fourteen fishing resources, seven
families and twelve fish. All fourteen anglers plus seven additional arrivals
were admitted on distinct dry in-range shores. Real cancellation, entity
removal/re-entry and resource relocation end with 21 active sessions and no
pending gathers, reservations or movement intents. This proves observed CPU
admission/lifecycle, not durable rewards, socket reconnects, full collision,
bank journeys, native crowd quality or every randomized arrangement.

Final verification: 152/152 shared regressions; 68 server regressions with one
intentional candidate-only skip; candidate-v4 19/19 with zero skips. Shared
source typing covers 731 roots; server typing covers 3,953 transitive sources;
both have zero diagnostics and stable pins. Scoped lint/formatting pass.
The new cases use actual systems/filesystem loaders; existing mocked custody
suites are regression coverage, not real death/database transaction acceptance.
Early fixture/type/expected-zone failures remain recorded and corrected.
No timeout, pathfinding, render-quality or resource budget was increased.

Build13 emits eight isolated bundles from 973 stable inputs, preserving 145
protected compiled artifacts. Native29 verifies eight actual client zone/
protection/lobby samples, including both overlap and lower-edge cases. The
original 90-second startup gate passes, camera/grass settling is 11.008s within
30 seconds, and five HUD leases complete. Root inspected the captures: the
fine dock grid still appears at production shadow bias and disappears under
the temporary zero-bias control. Defaults, materials, camera and clock are
restored. Scheduler-disabled streaming-state 503s and the known cow-model 404
remain recorded; no full-runtime, streaming, performance or final-art approval.

Runtime15 and the owned browser are closed, its ephemeral database is removed,
and cleanup has no errors. Playable localhost:3333, its server/database and
compiled bundles remain unchanged. Independent source review found no
remaining checkpoint blocker. Keep LAYOUT-01–08 open; next qualify actual
custody/queued-challenge transactions and full-width bank routes, followed by
whole-scene shadow behavior and stronger bank/planting/dock art.

Evidence: service-layout-network01-UNQUALIFIED/arena-footprint-regression03,
arena-footprint-types02, arena-footprint-server-types01 and
fishing-capacity-candidate-v4-01; inland-pond-integration01-UNQUALIFIED/assets-v4,
isolated-build13-report, native29 and runtime15. Do not promote this candidate.

## Fishing approach, fitted dock supports and shadow attribution checkpoint

The seven-family / twelve-fish pond contract remains: fourteen simultaneous
anglers plus additional arrivals, every-tier shore access and two distinct,
characterful procedural docks. None of the layout acceptance gates is closed.

Fishing approach selection now enforces the authoritative four-metre radius
and uses four tile rings instead of ten. Rejected movement releases reservation
and arrival emote. An exhausted route may choose another valid shore without
resetting the original deadline or completion ID. Recovery requires a
movement-owned failure for that exact destination, with no active/deferred
route. Explicit stops and replacement intents clear stale failure evidence.
Independent review caught an intentional-stop restart regression and verified
the correction. No retry, pathfinding or timeout budget increased.

Final CPU gates: 68/68 canonical regressions, 18/18 real-owner tests against each
immutable baseline and candidate manifest set, 16/16 dock tests, shared typing
729 roots and server typing 3,954 transitive sources with zero diagnostics;
scoped lint/formatting pass. Three old mock-only fishing cases were superseded
by actual-owner coverage, including four-angler relocation, real obstruction
and BFS deferral, active/deferred stops, exact failure identity and cleanup.
These checks do not prove fourteen simultaneous catches, persistence,
transport, economic custody or long-run capacity.

Dock caps meet the actual plank underside and shafts meet the cap underside.
Counts, deck position/index prefixes and five legacy whole-buffer goldens
remain exact. Native PhysX retains 86 rays plus 16 support-site rays. The source
does not change shaders/materials, textures, seeds or collision top surfaces.
Build12 emits eight isolated bundles from 973 stable inputs and preserves all
145 protected compiled outputs.

Native24/26/27 isolated the fine dock grid to shadow reception/bias, not the
actual board variation or filtered grain. Native28 repeats the comparison on
the corrected geometry. Its original 90-second startup gate passes, landing
camera/grass settling is 10.209s within the unchanged 30-second gate, and all
five HUD leases complete. Root inspected the images: support-cap patches are
gone; the fine grid persists at +0.0002 sunlight bias and disappears under the
temporary zero-bias control. Shadow casting/reception remain enabled in that
control; production defaults are restored and unchanged. Qualify both docks,
contacts, terrain, vegetation, animated avatars, pavilion and arena surfaces at
multiple actual light angles before promoting a bias change. This is not
final-art, runtime-wide error-free, streaming or performance acceptance.

Native22/23/25 helper-selection/discovery failures remain recorded.
Native21's third HUD-root failure came from the intentionally scheduler-disabled
runtime's independent 120-second waiting-for-duel-data UI timeout. This does not
erase native19/20's actual 90-second grass-startup failures.

Evidence: inland-pond-integration01-UNQUALIFIED/native22–28, build12 report and
runtime13–14 cleanup; service-layout-network01-UNQUALIFIED/fishing-approach-
regression06, baseline05, candidate05, types06, dock-support-* and
pond-dock-cap-types01. Owned test browsers/runtime/database are closed;
playable localhost, its database and compiled bundles remain unchanged.
Keep all LAYOUT-01–08 gates open. Next: arena/custody footprint and all-tier
crowd access, then whole-scene shadow qualification and stronger bank/dock art.
Do not promote the unqualified pond manifests.

## Pond capacity, headland and timber checkpoint — candidate remains unqualified

The launch contract covers all seven fishing families / twelve fish, fourteen
simultaneous anglers (two per family) plus additional arrivals, every-tier shore
access and two distinct procedural docks. These are acceptance requirements,
not a claim that fourteen spawned resource entities prove usable capacity.

Read-only gameplay review found two independent blockers. The broad arena
rectangle contains ten of fourteen fishing targets, the supplier and landing;
seven complete four-metre interaction disks lie inside it. An explicit compact
facility protection footprint must be applied consistently to custody, drops,
ammunition, evacuation and lobby challenges without widening privileges or
removing ordinary safe-area custody. Validate full-width bank routes too.
Fishing approach search also lacks the authoritative four-metre reach filter,
ignores rejected movement admission, and does not prove fourteen distinct
usable approaches or relocation spacing. Existing mocked-shore / three-resource
soaks are not live basin capacity evidence. All remain unchecked launch work.

The isolated art candidate adds a southern turf headland, unequal coves and a
third ground-cover sector, retaining water center/datum/envelope and both dock
positions. Measured water area is 1,034.91m² (96.84% of the previous 1,068.73m²),
shoreline 117.72m, dimensions 41.97 × 34.47m. Actual admitted indexed terrain
passes 169,560 probes with maximum 1.099cm height and 3.097° facet-normal error,
finite/unit mesh normals and exact shared seams. Worst leaf uses 64,670/65,536
extra vertices: only 866 spare, not scalability approval. No cap was increased.

Compact timber uses stable dock/member/board identity and one shared local
growth field for side/end color and roughness. No textures, micro-normal,
material slots or geometry were added; physical top buffers remain exact.
The historical zero-mask path remains, but pixel equivalence is unproven.
Native review below does NOT approve the new timber appearance.

CPU verification: 15/15 dock cases; 91 canonical terrain/path/habitat passes
plus one intentional candidate-only skip; 7/7 actual-admission checks; 729-root
source typing with zero diagnostics; scoped lint/formatting. Water/fishing
records 26 passes and one failure: the historical test shrinks only the water
envelope to 12m while keeping the 27m basin. Its immutable old-candidate control
fails identically. Keep the containment guard and the failed receipts; do not
describe that full run as passing. Earlier fixture/type failures are retained.

Build11 emits eight isolated bundles from 973 production inputs; only the dock
source differs from build10. Assets-v2 contains three exclusive manifests; old
candidate assets remain unchanged. All 145 protected outputs retain hashes.
Native19 and native20 FAIL the original 90-second startup gate with 4 and 30
grass cells pending. Native20 records 30 running grounding jobs, no waiting/
failed jobs or LOD swaps. Changed shore cover can affect local work; no causal
regression is established. Timeouts, density, resolution and budgets are intact.

Native21 is a separately labelled art diagnostic. Its original 90-second startup
gate passes; the optional 60-second inspection allowance is unused. Camera/
grass transitions pass their original 30-second gates at 29.06s / 11.69s / 4.37s,
with fourteen actual fishing entities in every observation. Overall native21
still FAILS: third-view HUD root identity changes, and its PNG contains the
loading-timeout overlay, not usable jetty art. The first two HUD leases complete;
camera/clock restore, browser closes and source pins remain stable. A recorded
grounding slice reaches 42.1ms; this is not seamless/sustained performance proof.

Root inspected all PNGs. The overview's headland improves the outline, but the
bank collar, blank service pads and sparse habitat still look artificial. The
landing timber remains grid-like/crosshatched. Do not mark final art complete.
Actual submitted WGSL confirms the compact field is active; retained legacy
terms have zero final compact weight. Half-metre joints can explain broad bands,
not the finer second line family. Next isolate actual board variation, filtered
growth and constant PBR under the same geometry/camera/light; fragment-hash
precision amplification is only a hypothesis. The third PNG provides no jetty
art evidence. Request diagnostics attribute all 41 native21 HTTP503s
to /api/streaming/state, whose scheduler is intentionally disabled in this
private runtime. The known missing mob model stays within placeholder scope.

Evidence: inland-pond-integration01-UNQUALIFIED/native19–21, build11 report,
candidate-manifest-assets-v2 report and pond-water-envelope-baseline01;
service-layout-network01-UNQUALIFIED/pond-headland-*, dock-growth-* and
pond-dock-art-types02. Runtime12, its temporary database and owned browsers
are closed; human localhost/DB identity and bundles remain unchanged.
No final art, live concurrent fishing, route/custody, stream, smoothness or
launch approval. Keep every LAYOUT-01–08 gate open and do not promote assets-v2.

## Shared grounding budget checkpoint — three native pond views captured

The small scheduler change is verified, not a full performance or art pass.
A ready-empty result can now use the remainder of the manager's existing 2ms /
8,192-operation allowance for the next nearest running job. The continuation
accepts a finite absolute deadline capped by its own standalone limit. Every
handoff retains input/region/surface/LOD ownership checks; at most one nonempty
mesh is published. Failure, waiting and cancellation terminate that call.
No density, shader, terrain, shadow, resolution or timeout setting changed.

Four new real-owner regressions include an actual grass-free service footprint
and real worker output, not substituted empty arrays or fake clocks. Both
changed suites pass 139/139; generation/pacing suites add 50 passes. The opt-in
pond cost diagnostic is skipped by its normal environment gate. Source typing
passes 727 roots with zero diagnostics and stable pins; scoped ESLint/Prettier
pass. Isolated build10 emits 8 bundles from 973 inputs without changing 145 protected
outputs. All four production/test source hashes match the qualified inputs.

Native16 first establishes queue-isolated render evidence by leasing the full
world tick, keeping Three's animation loop and rejecting unrelated queue work.
Its five forced samples have identical draw receipts: 6 passes, 427 reported calls,
3,390,305 triangles. Median GPU envelope 65.405ms and submit-to-idle wall 74.3ms
are diagnostic only: partial-transition population, overlapping pass intervals,
driver/IPC/scheduling and one 140.05ms GPU-envelope outlier. Its failed transition
was stamped after two initial animation frames; do not call it exact cut-to-ready
acceptance. Native17 restores the original cut timestamp and still fails.

Native17's complete observed ledger proves 34 empty completions each stopped a
frame with work remaining, despite 11.8ms total slice time. Native18 verifies the
new shared-budget handoff in real Chrome/Metal: 1,278 manager calls / 1,161 advances,
125 ready retirements (71 empty / 54 published), zero remaining jobs, and eight
multi-slice calls (maximum 13 continuations). Each grouped call retains one shared
absolute deadline and correctly debits its actual operation count; no call
exceeds 8,192 operations or one nonempty publication. No ledger overflows,
observation errors or owner changes; every hook is restored.

Native18 passes all three original 30-second transition gates: overview 28.02s,
landing 11.29s and jetty 3.89s. This is one observed run, not a causal benchmark or
sustained smoothness proof. All eight multi-slice calls measured at most 2ms;
the largest 38.6ms manager call was one continuation, not a handoff. Cooperative
checks cannot preempt allocations/GC or scheduling pauses; diagnose the actual
stall owner before claiming its cause or a hard 2ms wall-time guarantee.

All three native views have 14 actual fishing entities, two of each family, and
restored HUD/camera/clock controls. Root inspected all three PNGs. The pond still
reads too oval with uniform banks; timber reads repetitive/crosshatched; the
surrounding service pads and sparse habitat do not meet final world composition.
The retained console has 41 generic HTTP503 errors without request URLs and five
known missing-model 404/load errors. No runtime-wide error-free claim; attribute
the HTTP503 requests before accepting integrated health. Keep the existing
temporary mob placeholder scope; do not divert this work into a new cow asset.
No art, 14-concurrent-fishing, dock-route/custody, full-stream or sustained-FPS
approval. Keep all LAYOUT-01–08 gates open and do not promote this candidate.

Evidence: `inland-pond-integration01-UNQUALIFIED/native16–18/`,
`isolated-build10-report.json`; CPU receipts in
`service-layout-network01-UNQUALIFIED/grass-empty-handoff-*`.
Owned browsers, runtime10, runtime11 and ephemeral databases are closed, with
human client/server/DB identity and 145 protected hashes unchanged. Runtime09's
failed startup never produced a valid baseline receipt; retain its recovery
note and do not count it as a successful runtime. No dependency install,
human bundle overwrite, merge, deployment or real-value action occurred.

## Static avatar texture checkpoint — exact pixels, lower native allocation

The source now conservatively shares a source material's base/emissive texture
only for parsed static PBR VRMs with the same actual ImageBitmap and complete
matching texture state. Unknown metadata, animations/expressions, actual
texture-transform payloads, custom material callbacks and unequal UV/upload/
sampling state preserve the existing separate views. No cross-asset pool,
texture resizing, mip reduction, quality-setting change or asset rewrite was
introduced. Material instances remain independent; borrowed textures/images
are not disposed by the sharing decision.

Review caught a new coupling before acceptance: source setup callbacks can
change only the emissive transform. Sharing now occurs after every callback,
including repeat visits to a shared material, and checks new custom render/
compile hooks. The actual browser regressions verify those cases. Initial
native fixtures also correctly failed production eligibility: the installed
VRM loader injects an optional KHR_texture_transform declaration even without
a payload. Only that optional declaration is admitted; required declarations
and every actual nested transform payload remain rejected. Failed fixture01–03
receipts are retained. Their first preview sheets also had an evidence-only
row flip, corrected for WebGPU readback in fixture03 onward.

Final source gates: 53/53 real-class tests across material, bone-transform and
loader recovery suites; 726-root source typing with zero diagnostics and
stable inputs; scoped zero-warning ESLint and Prettier. Build09 emits eight
isolated bundles from 973 source inputs; all 145 protected compiled artifacts
retain their hashes. Intermediate build07/08 are retained but not the final
qualified source revision. No project dependency installation was run.

Chrome/Apple Metal fixture04 loads actual banker.vrm through the production
loader/plugin with its real ImageBitmap cache policy. Day/night and shadow/
unshadowed pixels are exactly equal before/after; 2,299 changed pixels witness
real shadowing, 69,946 witness lighting response and 16,514 witness the avatar.
The two 2048², twelve-mip sRGB native color allocations become one:
44,739,240→22,369,620 payload bytes. The actual factory creates independent
sibling materials; removal/material disposal of one sibling leaves the other's
pixels and borrowed native texture intact. Ten browser rejection/order cases
pass, with zero GPU validation errors and restored/disposed fixture resources.
The root agent inspected the correctly oriented contact sheet. This is texture
correctness, not approval of the temporary NPC art or character animation.

Native15's integrated pond census uses the original profile, 1280×720/DPR1,
camera poses and 30-second transition gate, with no calibration/timing hooks.
It records 310 creations/two destroys versus native14's 325/two. Known live
payload falls from 2,146,732,526 to 1,811,188,226 bytes: 335,544,300 bytes
(about 320 MiB). Independent comparison matches all 15 NPC/mob texture groups
and 35 character instances: both color slots remain, each old pair becomes
one native allocation, and all 30 recorded texture-state fields match.
Non-character live native allocation descriptor multisets match exactly.
ImageBitmap IDs are run-local, not cross-run pixel hashes. Six native depth
footprints remain unknown and bounded owner/node attribution still overflows;
do not describe the payload as physical GPU residency or a complete heap census.

The full native15 run still FAILS the unchanged grass camera-transition gate.
Its final settling observation has four grounding jobs and one LOD swap.
The retained failure screenshot shows the loading overlay, not an approved
pond view. No FPS recovery, final pond art, public stream, fourteen-concurrent-
angler gameplay, route/custody, or sustained-performance acceptance is claimed.
All layout and world-art gates remain open.

The mirrored pond contract now explicitly requires fourteen simultaneous
anglers (two per family), actual tool/consumable/reward/relocation handling,
and additional-arrival behavior without blocked through-routes. Two distinct
procedural docks, every-tier shore access, inland placement and natural world
composition remain required and unapproved.

Evidence: local `inland-pond-integration01-UNQUALIFIED/avatar-texture-native04/`,
`native15/`, `avatar-texture-census-comparison.json` and
`isolated-build09-report.json`; final CPU receipts are
`service-layout-network01-UNQUALIFIED/avatar-texture-{tests,types,lint,format}03`.
All owned Chrome/HTTP sessions and runtime07/08 are closed; both disposable
databases were removed. The human localhost client/server/database and all
protected output hashes remain unchanged. No human bundle promotion, merge,
deployment or real-value action was performed.


## Native allocation checkpoint — measured duplication, no quality reduction

This diagnostic-only slice changes no production code, assets, resolution,
grass density, terrain accuracy, shadow quality or acceptance deadline.
The seven fishing families, 12 fish, two positions per family, two distinct
docks and non-dock access remain the pond's open acceptance contract.

Native12 proves that two pond depth captures use different native destination
textures with a depth-writing back-side draw between them. A shared capture
cannot be assumed equivalent at grazing or underwater views.

Native13 records 29 frames with independent query pairs for each actual
initial/resumed render pass, zero GPU errors and 87 created/destroyed diagnostic
resources. Its unchanged 30-second transition still fails. The roughly 93ms
median timestamp envelope spans overlapping work, not exclusive pass costs
or steady-state FPS. Dawn's Metal implementation samples vertex start and
fragment end; these boundaries do not serialize intervening stages. See
[Dawn's Metal source](https://raw.githubusercontent.com/google/dawn/main/src/dawn/native/metal/CommandBufferMTL.mm)
and [Apple's counter profiler](https://developer.apple.com/documentation/xcode/analyzing-apple-gpu-performance-using-counter-statistics).
Do not sum the captured intervals to assign shader costs.

The census attaches before renderer texture creation and observes 325 native
allocations, two explicit logical destroys, 323 remaining textures and no native
counter overflow. Supported formats total 2,146,732,526 live texel/block bytes;
six depth-format footprints are intentionally unknown. These are not physical
resident bytes, allocator padding, canvas presentation or GC accounting.
The 321-texture Three estimate remains 2,194,944,230 bytes. Owner/node traversal
hits explicit bounds, so attribution is partial even though allocation capture
has no observed omission and no untracked Three native references.

Seventy-seven 2048-square RGBA8 full-mip allocations account for 1,722,460,740
bytes. Native14 traces 30 of those to 15 NPC/mob map/emissive pairs. Each pair
shares the exact ImageBitmap object and matching captured sampling, UV and
upload state, yet holds separate Three/native textures. The narrow opportunity
is approximately 320 MiB without changing pixels—not all 640 MiB occupied by
those pairs. Sixteen hashed large DataTexture CPU views are distinct. No
ImageBitmap canvas conversion or GPU pixel readback was used in this census.

The independent file audit reads only candidate-manifest references: 18 VRMs,
17 present, the already-known cow asset absent. All 17 present files contain
equal embedded base/emissive PNG bytes, equal sampler settings and UV0 with no
texture transform. There are 17 different hashes across assets. No declared
expressions, UV-animation factors, texture-transform bindings or glTF animation
channels appear in those files. The audit artifact SHA-256 is
`8ad20b27205fd6273f12663873d86fca04b4d43f2e38fd84d5a893e10a0d7e18`.

Next implementation: verify static-texture eligibility at the parsed GLB/VRM
factory boundary, then reuse only a source material's exact matching immutable
base/emissive texture. Default to no sharing for unknown/dynamic metadata or
different full state; retain independent per-instance materials. Do not pool
across assets, change color interpretation, dispose borrowed textures, or close
the shared ImageBitmap. Require real parsed-file and clone/lifetime tests plus
native same-pose pixels and allocation counts. This is not implemented yet.

Native14's five-frame queue-drained calibration rejects 50 writes outside
graphics.render before sampling any frame; no isolated GPU cost is claimed.
Source inspection points to the per-world-tick grass frustum upload, but the
capture has no buffer label and does not prove that owner. Future isolation
must own the complete world-tick producer and retain queue guards, with no
silently altered simulation clocks or resumed-gameplay claim.

Evidence: local `inland-pond-integration01-UNQUALIFIED/native12–14/`, including
the retained native14 runner/helper sources, texture census/fingerprints and
`avatar-image-audit.json`. All browser hooks, camera/clock leases and owned
browsers restore/close. Runtime06 is stopped through its owning parent and its
disposable database is removed; human localhost and protected outputs remain
unchanged. All layout/art/concurrent-fishing/performance gates remain open.

## Grass storage checkpoint — verified rendering, unresolved pond performance

The production change is limited to the two GrassVisualManager constructors.
It uses the existing versioned storage helper on each private cloned geometry;
identity matrices, population, dirty versions, transforms, geometry, grounding,
wind, culling and retirement logic are unchanged.

Four complete real-class suites pass 112/112 tests: GrassVisualManagerCells,
GrassVisualManagerGeneration, GrassVisualManagerPacing and GrassGroundingGpu.
Scoped lint/format and source-only 725-root typing pass with stable inputs.
Build06 produces eight isolated bundles from 973 source inputs and preserves
all 145 protected compiled artifacts. Human localhost bundles are not promoted.

The actual Chrome/Apple Metal grass-storage-native01 fixture passes both active
fine-meadow LODs with nine clumps each at 1.25s and 3.75s wind phases. Ordinary
and storage paths have exactly equal color/received-shadow pixels. Wind changes
18,042 and 10,180 pixels; first-phase shadows affect 2,679 and 1,581 grass
pixels. A translated/yawed parent is included. GPU matrix readback matches
CPU identity bytes; unchanged/wind frames issue zero matrix uploads. Three
vertex storage bindings and seven vertex backings fit the device's limits of
eight each. Actual precompile and both LOD owners dispose root, visibility and
matrix allocations exactly once. All fixture workers, browser, HTTP and
renderer resources close. The inspected comparison sheet is a raw linear
correctness preview, not approved meadow color/lighting/art.

Native09 reaches 14 actual fishing resources and 65 observed grounded chunks
with private storage matrices, but fails the same 30-second pond transition.
Its instrumented trace still attributes 22.16s of 29.88s to native writeBuffer;
25 jobs remain in the last observation. This does not establish a speedup or
regression against earlier non-matched runs, nor prove transfer bandwidth is
the bottleneck. Native10 also fails, with 14 jobs in its last observation.
The emitted per-pass GPU times must not be summed or treated as exclusive
costs before checking actual resumed-pass timestamp-slot ownership.

Native11 proves that attribution defect: 2,580 allocated intervals correspond
to 3,870 actual native passes and 1,290 framebuffer-copy resumes. Every resume
uses mismatched descriptor indices, another encoder's UID and repeated slots
within that same allocation generation. Both per-frame depth-copy resumes
occur while drawing WaterQT_elevated_haven_pond_water; main context 0 reuses
sun-shadow context 6's indices. All bounded counters are complete with zero
overflow. This invalidates native10/11 per-pass cost attribution; it is not
proof that timestamp tracking (normally disabled) causes production slowness.
The diagnostic view still fails its scalar-read deadline. Query pools and all
observer/camera/clock hooks restore, and the owned browser closes. Next use
independently owned per-actual-pass queries, or a calibrated isolated fixture,
before interpreting GPU intervals. Do not silently patch vendor defaults.

Native10 additionally records 2,194,944,230 nominal texture bytes across 321
textures. Three's accounting is not a measurement of resident GPU memory;
pair actual texture owners with native allocations before changing assets.
Do not make further vegetation/batching/texture changes solely from CPU
write-call samples or these unqualified timing numbers.

Read-only texture audit does not identify the dominant allocation. Known source
sizes for seven 1024-square compact terrain maps are only about 37.3 MiB with
mips; outdoor atlases add about 18 MiB. Large disabled impostor arrays must
not be counted as live allocations without evidence. ModelCache deduplicates
resolved model URLs, while separate GLB/LOD images and converted DataTextures
can still duplicate content. Next, census real native texture creation and
logical destruction from before world boot, then attribute those allocations
to actual cached material and submitted-binding owners. Preserve resolution,
mips, sampling and color spaces. Share only proven byte-identical images with
identical rendering state and correct leases; do not guess from file names.

The route audit also preserves a concrete unadopted candidate: pond center
425,415; tighter campus x336..397/z365..421; public preparation connectors
x344..406/z336..363 and x397..406/z350..382. Real server paths can shortcut
across campus despite road paint. First test the actual destination planner;
if necessary, enforce opted-out agent admission at the shared traversability
seam, not through death/drop exceptions. Preserve diagnostic-only custody
approval and exact boundary/overlap semantics. These are planning bounds, not
approved physical access, rendered terrain or economic-zone qualification.

Local evidence: inland-pond-integration01-UNQUALIFIED/build06,
isolated-build06-report.json, native09–11 and grass-storage-native01;
service-layout-network01-UNQUALIFIED/grass-storage-* contains CPU receipts.
LAYOUT-01–08, final pond art, route/custody separation, simultaneous all-tier
fishing and sustained frame/loading/memory acceptance remain open.

## Pond follow-up — all-tier client coverage and upload diagnosis

Native03 reaches the real client with 14 fishing entities, exactly two for
each of the seven families. That verifies replication, not simultaneous
fishing capacity, supply/bank routes or economic-zone admission. The pond
remains an isolated candidate; LAYOUT-01–08 remain open.

Per-job observations record 57 distinct keys/continuations, monotonic sampled
work and stable camera/terrain focus after the initial update. The unchanged
30-second grass transition still fails. This is observed serialized work,
not an established invalidation loop. Native04 CPU sampling redirects the
investigation: 20.96s of native buffer-write samples in a 29.85s trace, of which
19.995s is inside shadow binding updates. Driver/GPU backpressure can appear
at that call, so native timing alone is not proof of redundant transfers.
Native05–07 count exactly one sun-shadow render per main-scene render.

Native07 then proves a concrete redundant path by reference identity:
16 actual 512-slot instance matrices become 32,768-byte raw uniform buffers,
each updated 507 times during 507 shadow renders; eight observed owners are
empty. The installed Three r186 raw NodeUniformBuffer does not track matrix
attribute versions. The scoped source candidate changes only the GLB tree
and resource pool constructors to storage-backed matrices. It retains the
exact initialized array, capacity, static usage and existing dirty/LOD/slot
protocol. The storage attribute is registered on each private pool geometry
for renderer-owned disposal. Pool cloning is outside this helper's contract.

- Actual World/ClientLoader/HTTP GLB owner-lifetime suites and real Three
  matrix/bounds/raycast parity: 20/20 tests pass (including four added cases).
- Source-only 723-root typing including both changed test files: zero
  diagnostics and stable inputs. Scoped ESLint, formatter and diff checks pass.
- Build05: eight isolated bundles, 973 source inputs and all 145 protected
  compiled artifacts unchanged. No package installation or lockfile change.
- Native08 removes the raw 512-matrix uniform bindings, but does NOT close
  the performance gate: the pond cut still fails at 30s with 13 jobs in its last
  per-job sample. About 20.7s of sampled buffer-write time remains; attribution
  now includes raw grass/vegetation instance matrices in the main scene.
  This is a scoped unnecessary-upload fix, not proven sustained FPS recovery.
- All native03–08 test browsers close and diagnostic controls restore.
  Runtime03 and runtime04 shut down cleanly and removed only their own private
  client/server processes and disposable databases. Human localhost remains up.

The actual Apple Metal `storage-native03` fixture now passes: exact initial
and final 256 × 256 color and isolated-shadow pixels; all 32,768 matrix bytes
agree across ordinary CPU/native upload and storage GPU readback; zero matrix
uploads in three unchanged frames both before and after one dirty mutation.
That mutation causes exactly one upload and changes 3,358 color/1,640 shadow
pixels. Both passes bind the same read-only allocation within device limits.
Disposal calls real GPUBuffer.destroy once, removes backend ownership and
native validation rejects a subsequent use. No console/page/GPU errors escape;
renderer, observers, Chrome and owned HTTP port 3345 clean up. Native01 of this
fixture failed because manual same-frame renders reused Three's shadow map;
the verifier now uses distinct real animation-loop frames, not forced shadow
internals. Native02 passed; Native03 adds actual GPUDevice adapter identification.
The root inspected the generated fixture contact sheet. This is static-helper
correctness, not complete tree wind/dissolve or game-world visual acceptance.

Qualify the relevant grass/vegetation owners separately before extending this
optimization. Grass has private cloned chunk geometry and one-time identity
matrices. Vegetation has dynamic usage and alternate screen-space LOD geometry
ownership that require a separate disposal/update contract.
Do not reduce density, shadows, resolution, terrain accuracy, timeouts or work
budgets. Native final art, full streaming, route/custody separation and the
pond's multi-agent gameplay acceptance are still open.

Local receipts: `inland-pond-integration01-UNQUALIFIED/native03–08/`,
`isolated-build05-report.json`; `service-layout-network01-UNQUALIFIED/`
contains `instance-matrix-storage-tests01`, scoped lint and
`instance-matrix-source-types01`.

Primary implementation references checked against installed r186:
[storage instance attributes](https://threejs.org/docs/pages/StorageInstancedBufferAttribute.html),
[instance accessor source](https://github.com/mrdoob/three.js/blob/r186/src/nodes/accessors/Instance.js),
[shadow-node contract](https://threejs.org/docs/pages/ShadowNode.html).
The reference examples guide investigation; they are not performance evidence
for this game.

## Bounded large-bank refinement — native startup recovered, transition still open

The follow-up fixes the exact native01 terrain-cap failure. Broad full bank
rings whose unconditional fine lattice would exhaust the existing vertex
allowance now start coarser and refine under the same canonical error criteria,
retaining the original finest step and forced seam detail. Associated outer
shoulders use the same bounded hierarchy. No vertex, triangle, face-per-cell
or geometric quality cap is raised, and no source landform is changed.

Dense checks caught a new thin-strip shading regression: asymmetric hanging
edge cuts produced a12.91-degree face-normal deviation when center-fanned.
Propagating only required cuts across these broad-bank strips and sampling
their added vertices canonically repairs the witness to0.0930968975degrees,
matching historical fine geometry. Blanket skinny-cell refinement was rejected
because it exceeded the unchanged cap. Intermediate failures remain retained.

- Exact410,415 candidate: four real terrain leaves,169,560 indexed/canonical
  probes, maximum height error10.988mm and face-normal error3.097degrees under
  existing20mm/6-degree gates. Largest surface79,798 vertices,63,414 extra
  vertices (2,122 headroom) and370 maximum faces per cell.
- All four shared-edge vertex, normal and skirt comparisons match. Historical
  small-pond buffer hashes remain exact. Other basin placements, including
  the suggested425,415 layout, are not qualified by these receipts.
- Focused inland gate2/2; art03 geometry/water59pass with one candidate-only
  skip; stock58pass with two candidate-only skips across actual matched suites.
  An initial mistyped water filter matched no suite and is not counted.
-720-root explicit source/test typing, ESLint, formatting and whitespace
  checks pass. Production SHA44a2ed286606f2b9e1d6fd0a4497883a4c3f7e278bc06f389c38a0ebf5d089c5.
  Source receipts are `inland-refinement-*` in the existing local evidence.

Build04 pins972 source inputs and leaves all145 protected artifacts unchanged.
Native02 on actual Chrome/Metal passes the unchanged startup readiness check:
29/29 terrain,122/122 initial-camera grass, and ready conforming water topology
(55 partition leaves,53 water chunks). This resolves the observed startup-cap
failure, not the whole visual/streaming requirement.

The subsequent diagnostic pond-camera cut fails its unchanged30-second grass
settling deadline: four grounding jobs and one LOD swap remain, with no failed
or cancelled grass jobs reported. The controls restore and owned browser
closes. No finished art screenshots,14-fish client assertion or sustained
performance gate was reached; the captured image remains the stream loading
screen, and no full-stream readiness is claimed. CPU regression jobs overlapped
part of this run, so it is not a controlled performance benchmark. Diagnose
actual work and verifier camera ownership rather than hiding the overlay,
extending the deadline or reducing quality to obtain a passing image.

Planning also identifies a potentially useful15m eastward pond translation
plus a tighter, explicit arena safety envelope. That remains unadopted: the
bank bypass must not trigger arena evacuation or introduce unclassified
external-value custody space. Full route/zone admission and live economic
boundary tests are required before any canonical placement promotion.



## Complete fishing candidate and timber docks — source checkpoint, native load failed

This opt-in slice adds all-tier fishing coverage, relocated habitat, fitted
timber art and a pond-to-bank paint route to the isolated inland basin. It does
not relocate canonical assets or change the human localhost world. All
LAYOUT-01–08 acceptance gates stay open.

- The body-bound resource owner requests14 positions, two per seven families
  covering12 fish. It uses real wet targets, canonical ground and dry approaches
  within the existing interaction range. Existing registration leases reserve
  pending targets, roll back failures and constrain relocation to the same
  explicit water owner. Legacy resource admission remains unchanged.
- The detached manifest keeps fisherman_pete's quest/store identity, moves him
  beside the pond and adds feathers to existing fishing supplies. No item price,
  reward, level, custody disposition or economic policy is changed.
- Two merged dock meshes have closed12cm-thick plank sides and undersides,
  member-local filtered timber grain and rough PBR shading on one shared opaque
  material. Walking-top buffers stay byte-exact. Geometry totals are2703
  vertices/1432 triangles and3063/1576; these are not measured draw/frame costs.
-28 habitat instances form three unequal groups with protected dock/supplier
  approaches and exposed plant roots. Contact substrate follows the admitted
  new bank, avoiding stale paint at the old site.
- Actual RoadNetworkSystem startup initially rejected the old pond-bank path
  crossing the lobby. The opt-in replacement uses the lobby–hospital gap and
  landing/Pete approach; canonical-ground checks keep its full painted width
  dry without relaxing other water/floor exclusions. Paint is not proof of
  actual end-to-end collision navigation.

### Source verification

Local evidence: `service-layout-network01-UNQUALIFIED/`.

- `bound-fishing-tests07`:28/28 resource tests, including9 new real-system
  fishing cases, one unchanged historical mocked test and18 existing real
  registration cases. Actual typed spawn data fixed a test-only subtype error.
- `dock-timber-final-stock01` and `dock-timber-final-art03-01`:18/18 each.
  Closed-solid topology,20 additional upward native/mesh probes and86 existing
  downward contact probes pass under unchanged tolerances.
- `inland-habitat-tests02`:111/111 habitat, palette and actual emitted-worker
  cases. `inland-path-regressions01`:77/77 path/configuration/worker cases.
  `inland-candidate-admission-review01`:20/20 world-config cases.
- `pond-integration-types-final02`:720 production plus explicit test roots,
  zero diagnostics, stable hashes. Scoped final ESLint/Prettier/diff checks
  pass. Two missing terrain-interface declarations were corrected type-only.
  Suite counts overlap and are not summed as independent coverage.

### Actual native failure and remaining launch gates

`inland-pond-integration01-UNQUALIFIED/` contains three detached builds and
the real private-runtime/native01 receipt. Eight bundles have972 pinned source
inputs; build02 and the type-only corrected build03 are byte-identical. All145
protected compiled artifacts are unchanged.

The private server's database, manifest and world-identity admission passed.
Native01 used headful Chrome, actual WebGPU, Apple M5 / ANGLE Metal,
1280×720 atDPR1. It failed the unchanged90-second scene-readiness deadline:
`quad_68_d4_450_450` repeatedly exceeded the terrain-collar vertex cap,
leaving28/29 terrain chunks and conforming ocean topology pending. The retained
screenshot is a loading screen. No completed pond/dock art views,14-entity
client proof or performance acceptance was reached. Do not bypass readiness
or raise geometry limits to classify this run as successful. Missing-cow
placeholder and disabled-stream503 logs are retained, not claimed error-free.

The owned browser closed; runtime01 stopped its own client/server and removed
only its disposable database. Protected human service identities and bundle
hashes matched before/after. Localhost3333 was not restarted or replaced.

A separate gameplay blocker remains: the broad arena rectangle overlaps some
new fishing shore. Current rules would preserve inventory on ordinary deaths,
forbid ground drops, evacuate opted-out agents and permit lobby challenges
there. Ordinary gathering keeps its tool/level/consumable/custody authority and
no automatic PvP opening was found, but this placement must not be promoted
until zone/placement policy and real integration tests resolve the mismatch.
Full-bank journeys, simultaneous fishing, persistence/restart, all views,
daylight/night, frame time and memory remain unqualified.

Timber uses the existing [Three.js PBR node material](https://threejs.org/docs/pages/MeshStandardNodeMaterial.html)
and bounded [indexed geometry](https://threejs.org/docs/pages/BufferGeometry.html);
those primary references do not imply visual approval.



## Fitted pond docks and terrain refinement — source-only checkpoint

The two-dock foundation is implemented and verified with actual World, terrain,
Three and native PhysX objects. The test placements remain (390,424.5), eastward,
and (433,415.5), westward, within the checked-in inland basin study. No canonical
manifest or running localhost scene has been changed. All LAYOUT-01–08 gates
remain open, especially complete fishing capacity and integrated visual quality.

### Completed in this checkpoint

- Strict immutable opt-in manifest admission binds exactly two distinct dock
  recipes to one actual explicit pond, including its live radius-squared datum.
  Exact cardinal 3×6m cores and 2m landward approaches own 24 movement tiles each.
- One retained half-metre triangle surface supplies deck/apron drawing, native
  collision and movement heights. Posts sample the actual bed; first/last feet
  are set back half a metre to keep caps off the sloping approach. Rails have
  matching visible segments and dual-tile movement walls, with open entrances
  and deliberate casting gaps.
- Refcounted walkable-deck leases preserve underlying terrain, occupancy and
  other owners. Compact dock terrain rebakes sample canonical ground instead
  of the active deck. Atomic failure unwinds both docks, physics actors, meshes,
  grass exclusions and leases. Reentrant scene disposal cannot resurrect a dock.
  Client registration no longer treats walkable decks as optional scenery.
- The earlier three art03 coarse-assembly failures are resolved. The ownership
  fixture now uses production local-detail regions; mirrored-only refinement
  no longer projects an impossible coarse neighbour into distant terrain.
  Direct ring intersections still reject oversized detail, existing limits are
  unchanged, and fine seam geometry hashes remain identical to their goldens.

### Retained verification

- `dock-admission-tests01`: 52 manifest/DataManager tests, including mandatory
  water binding even when optional data validation is skipped.
- `dock-collision-tests02`: 172 actual collision/footprint/BFS cases.
- `dock-layout-setback-stock01` and `dock-layout-setback-art03-01`: 5/5 each.
  Two actual terrain placements, 3,250 Three rays with exact retained-height
  agreement, +Y triangles, 48 deck tiles, real support depths and all 64 support
  cap corners inside the flat platforms (minimum 0.13m margin).
- `dock-owner-native-tests02` and `dock-owner-native-tests03`: 11/11 each on
  stock and art03 assets. 86 merged-mesh/native ray checks, including front-cap
  approach probes; maximum native Y error 0.000001430511474609375m under the
  unchanged eight-Float32-ULP gate. Actual BFS, two rollback/retry failure modes,
  missing owners, registry mismatch, rebake/removal and scene disposal pass.
- Landing geometry: 967 vertices/792 triangles; jetty: 1,159/936. Two native
  actors/shapes, two merged meshes and one shared material. These are source
  geometry counts, not measured WebGPU draw/frame budgets or material approval.
- `refinement-art03-final01`: 150/150; `refinement-stock-final01`: 149 pass,
  one existing candidate-only skip. The art03 assembly fixture totals 153,050
  vertices/301,008 triangles including skirts, compared with stock 90,084/175,990.
  This added detail is explicitly **not** a production performance acceptance.
- `dock-owner-types-final01`: 718 roots including every new test, zero
  diagnostics and stable input hashes. `dock-infrastructure-regressions01`
  executed three real suites/13 cases; two nonexistent requested filters matched
  nothing and are not counted as coverage.
- `dock-protected01`: all 145 protected compiled artifacts and recovered
  lockfile unchanged. Localhost3333 returned HTTP200; the human client/server
  and database VM remained running. No installs, build replacement, database
  mutation or additional browser tabs were involved.

Earlier unsuccessful fixture probes remain in the local evidence history.
A negative test originally relied on which outer-grade guard fired first; it
now uses a real small terrain mutation to establish the intended clipping or
overdeep-post failure, independently of stock/art03 surroundings.

### Art, integration and performance still required

The current dock deck is a top surface, with inherited procedural wood bands,
not finished plank thickness, grain detail or approved dock art. Side structural
members extend beyond the walkable deck rectangle; it is not a full collider
bounding box. Full-world resource/station spawners can run after dock startup,
so the initial overlap check is not proof against later spawned obstructions.
Server startup still creates bounded mesh/material objects; no server GPU work
was measured or inferred. These limitations remain explicit before activation.

Next: integrate the relocated basin, habitat/contact data, all seven fishing
families/12 fish, tool/bait/feather supplier and bank routes into one isolated,
matched candidate. Then finish both dock silhouettes/materials and verify actual
gathering concurrency, walking, rendered/indexed/PhysX contact, day/stream views,
startup, frame time and memory. Source tests alone do not satisfy these gates.
Indexed geometry and explicit ownership follow the official
[Three.js BufferGeometry guidance](https://threejs.org/docs/pages/BufferGeometry.html);
that reference does not establish AAA visual quality.


## Inland pond/fishing source checkpoint — not layout promotion

The full-progression requirement is now part of LAYOUT-07 in all eight mirrored
planning documents: seven fishing families, 12 fish, tool/bait/feather supply,
a target of two accessible positions per family, shore access for every tier,
and two distinct, bounded procedural docks. Actual concurrent use and complete
bank/supplier routes remain mandatory acceptance gates.

### Implemented and measured

- Compact elevated water uses one static indexed mesh per basin, clipped to the
  sampled canonical terrain instead of a circular fan. True horizontal distance
  to the emitted shoreline includes dry islands and disconnected components.
  Ground sampling is separate from ocean staging and bypasses deck/cache
  overrides; existing ocean sampling and noncompact circle behavior remain.
- Fixed 0.5m pitch, radius at most 32m, at most 16,641 ground queries and 65,536
  triangles per basin are admission caps, not accepted frame-time budgets.
  No per-frame basin sampling was added. Constructor rollback disposes only
  newly owned geometry and preserves borrowed materials/containers/children.
- A checked-in **test-only design candidate**, not a runtime manifest, is
  `packages/shared/src/systems/shared/world/__fixtures__/inland-pond-basin-candidate.json`.
  Its SHA-256 is
  `62bf40a5ce72aae3ff5105b2403c67351600b121b1e24f0a0cc19be28427556f`.
  The preferred basin center is (410,415), with water Y24.6 and a conservative
  27m water envelope. Four unequal bank sectors form a higher northwest bank,
  eastern cove, southern shelf and southwest arrival bay. The grading envelope
  is 33m; it was reduced from the first study's 35m to avoid the existing lobby
  floor corner. Exact rendered floor/contact clearance is still unverified.
- In the art03 authored CPU field, 720 radial shoreline samples span
  X390.575–432.543/Z397.334–433.883, about 42 × 37m, with a 119.067m perimeter.
  Minimum sampled dry height at the 27m envelope is 1.015m above pond water.
  These do not establish navigation, actual indexed terrain or visual approval.
- Final stock CPU setup observations: current 7.5m body 703 vertices/1,224
  triangles/920 queries; 27m candidate 4,786/9,062/9,937; 32m capacity fixture
  8,574/16,458/13,796. Candidate setup was about 22ms in one run, not a frame SLO
  or benchmark. The art03 current pond has different authored banks and yielded
  715 vertices/1,242 triangles; those measurements are kept separate.

### Verification and retained failures

- `water-basin-tests04`: **17/17**, stock assets with no candidate environment
  override; the committed candidate is exercised by default, not skipped in CI.
  Real World/TerrainSystem/WaterSystem/Three objects, independent boundary
  distance oracle, exact-height contour cases, island/separate-pool coverage,
  radius caps, ocean/basin sampler separation and atomic rollback are covered.
- `inland-water-regressions02`: **102/102** across eight stock source suites
  covering conforming ownership, ocean continuation/grid/edges, manifest water,
  lifecycle, radial-profile admission and grading.
- The same regression selection with the separate art03 overlay
  (`inland-water-regressions01`) is **99/102**: three coarse resolution-2 terrain
  assemblies reject annular refinement above the existing axis cap, before
  water publication. No cap was relaxed. This profile/fixture combination and
  integrated candidate coarse-LOD behavior remain open for qualification.
- `inland-basin-source-types03`: 711 source roots including the edited tests,
  zero diagnostics and stable hashes. Earlier types01 caught two missing
  test-body sourceType fields; corrected, not suppressed.
- Focused run02 retained one failing exact-contour ray assertion: its test ray
  lay on the actual shoreline rather than inside the dry strip. The corrected
  case separately checks the dry interior and zero-distance boundary; runtime
  geometry/tolerances were not changed to hide that failure.
- Source lint and scoped diff checks pass. All 145 protected compiled artifacts
  still match the art03 report; original recovered lock hash is unchanged.
  No dependency install, live build replacement, browser launch, database
  mutation, runtime pond relocation or canonical-asset promotion occurred.
  Native WebGPU appearance, PhysX/indexed agreement, gameplay and target-device
  frame/loading/memory qualification remain open.

Local receipts: `asset-studio/game-test-integration/service-layout-network01-UNQUALIFIED/`.
The committed source/fixture and this narrative are durable; local measurement
logs, sampling scripts and captures are not represented as GitHub artifacts.

### Next integrated slice and dock audit

1. Rebind old coordinate-specific terrain contacts and explicitly admit a larger
   planted habitat; move terrain, water, fishing, supplier and approach data
   together. Remove the old pond/spot placement only in that matched candidate.
2. Replace dynamic-list-only fishing coverage with verified full-family targets,
   supply availability, concurrent gathering reservations and short bank routes.
3. Reuse the existing dock generator but first fix its elevated-water owner:
   it currently assumes ocean water, a fixed 3m bed, reversed north/south bearing,
   and rails whose collision exists without visible rail geometry. Admit exact
   cardinal tile-aligned 3×6m candidates, sample actual post bottoms and author
   entry/rail openings once for both drawing and collision.
4. Give docks transactional shared deck/height/collision ownership, a real
   destroy lifecycle and removal/rebake tests. Existing dispose is not called
   by World.destroy, and client registration is scenery-gated. Ordinary terrain
   rebakes preserve nonterrain flags; this is not a claim that every rebake loses
   rails. Physics support, grass exclusion and restart readiness need real tests.
5. Run a matched isolated native Chrome/Metal candidate: walking, all fishing
   tiers, two docks, multi-agent approaches, close/overview/stream views and
   measured rendering/setup costs. No proposed placement is approved by this
   source checkpoint.

Reference review continued with the official
[Three.js WebGPU water source](https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/webgpu_water.html)
and [BufferGeometry documentation](https://threejs.org/docs/pages/BufferGeometry.html).
Indexed static geometry and bounded shared materials inform this implementation;
the water demo's full render pipeline and screen-resolution costs were not
copied wholesale or treated as an island performance guarantee.


This is a work-in-progress source backup on `codex/sol-duel-stream-launch`,
not a release, merge recommendation, completed MVP or AAA-quality certification.
World art remains the priority: one compact island, open service pavilions,
one procedural arena, coherent live resources, and bounded WebGPU effects.

## Checkpoint policy

At each coherent, verified implementation slice, review the exact diff, run
relevant tests, check formatting/types and secrets, then commit and push to the
existing feature branch. Also checkpoint before a substantial new subsystem or
ending an extended work session. Do not accumulate another multi-day backlog.
Small later commits should identify their subsystem and retained evidence.

Use the user's configured `dreaminglucid` author and committer identity. Verify
the remote branch SHA after pushing. Commit related runtime assets separately
on their existing asset branch and record the paired revision. Do not merge,
deploy, promote experimental defaults, include real credentials or push local
databases, dependencies, captures, numbered conflict copies or recovery files.
An unresolved visual/performance gate stays open even when its source is saved.

## Repositories and scope

- Application identity fix: `3f5c36601d139e94a52746e4c84386fcc6d1a284`,
  already pushed and GitHub author/committer verified.
- Paired assets: `PlayHyperia/assets`, branch `codex/duel-arena-launch-assets`,
  revision `1869ff1503a00c3eda74ea99e8b1161406ec8b05`, pushed with both LFS
  objects and GitHub author/committer verified. Only two new runtime files:
  - `terrain/textures/compact-pbr/ground-height.png`, SHA-256
    `f83da0f031244f046d72adf229723da5857d36a6cd5fc542d11db019a60bc06c`.
  - `vegetation/compact-pond-v1/pond_sorrel.glb`, SHA-256
    `2f887028b517ad2e6ea3c75665dc4790c59a0ae66ea41ff6185e5b5375777d22`.
- This integrated source checkpoint retains the coupled terrain, shoreline,
  grass grounding/ownership, water optics, bank pavilion, rendering diagnostics,
  cache fidelity, local-runtime tooling and regression work since September 14.
  Newly imported source/JSON files travel with their consumers. The exact
  historical grass-worker fixture is now inside Git instead of a sibling
  authoring folder; its original byte/hash assertions remain intact.
- Experimental world manifests are **not** promoted. The asset repository's
  unrelated deletions, PhysX changes, candidate animations and local backups
  remain unstaged. Six application permission-only differences, numbered
  duplicates and unrelated package-manager copies also remain local.
- Hyperbet is a separate repository and is not changed by this checkpoint.
  Editable Blender files and diagnostic media in the external art workspace
  are not backed up merely by pushing application source or runtime exports.

## Verification and honest limits

- Initial changed-shared-source regression: **1,788 passed, 3 failed,
  10 skipped** across 59 files. This failed receipt is retained.
  Two failures were stale test expectations after the bank's eight upper braces
  moved into the roof cutaway and the bounded polygon limit increased to 32.
  Corrected tests retain exact post/brace masks and now prove both the exact
  capacity and atomic rejection above it. Both affected suites pass **41/41**.
- The third failure was the real grass grounding job reaching its existing
  active-CPU limit under concurrent validation load. The isolated two-case
  worker/synchronous parity rerun passes **2/2** without changing production
  limits, replacing clocks or weakening assertions. This does not qualify
  target-hardware performance; the initial failure remains meaningful evidence.
- Shared production-source strict TypeScript passes without emitted files or
  incremental writes. The focused actual Vite/GLTFLoader identity test passes
  **1/1**; it is not a native-browser visual test.
- Stock client readiness/stats tests pass **37/37**. The initial six readiness
  failures were caused by an old compiled shared bundle lacking the new bank
  admission getter. A narrow test-only source graph now binds the collector,
  real World/DataManager and procgen recipe consistently. The production
  readiness gate was not weakened and the playable bundle was not rebuilt.
- Bank art02 procgen tests pass **12/12**; physical geometry bytes, roof/footing
  hashes and historical smithy outputs are unchanged. Only the eight brace
  visibility labels changed. Fresh native art/motion review remains outstanding.
- The relocated historical grass fixture passes its actual worker proof
  **1/1**, with original SHA and semantics intact.
- A real inherited-pipe shutdown fixture race was corrected using an IPC
  readiness handshake after the descendant installs its signal handler.
  The shutdown suite passes **27/27**, including five consecutive isolated
  runs of that case; production shutdown behavior is unchanged.
- Serialized script verification with the explicitly selected Bun 1.3.14:
  **90 passed, 0 failed, 2 evidence-dependent skips**. This covers launcher
  shutdown, asset-gate/world-config validation, diagnostic pond policy, GPU-probe
  contract checks, Tailwind source scope and procgen source-map packaging.
  Earlier runs without the pinned Bun failed 12 validator cases; those failed
  receipts remain preserved. No runtime version requirement was relaxed.
- Isolated direct Vite development lifecycle: **three loaded graph/HMR/shutdown
  cycles pass**. Three preview shutdown cycles also passed in the earlier run.
  The concurrent first dev run's dependency-optimizer HTTP 504 remains retained;
  the passing rerun is not a claim that the first attempt succeeded.
- Native movement bootstrap tests remain **unqualified in this checkpoint**:
  two require ports owned by the protected playable session and fail with
  `EADDRINUSE`. No running human service was stopped or reused to obtain a pass.
  Next tooling task: an explicitly validated all-or-none local port tuple,
  ephemeral test allocation, and actual native gameplay rerun. The current
  movement harness source is preserved as work in progress, not certified E2E.
- Formatting checks and staged diff checks pass. Scoped ESLint found two DOM
  type names without a namespace in an existing browser-test helper; qualifying
  them through `globalThis` removes both warnings without changing runtime code.
  Checksum-verified Gitleaks 8.30.1 found no secrets in the staged source or asset
  changes. The formatting-only hook was run as explicit checks rather than
  allowing `npx lint-staged` to temporarily hide the dirty live working tree.

Never combine overlapping run counts or describe filtered/evidence-dependent
cases as passed. No complete full-repository or production-launch pass is claimed.

The protected human client on localhost:3333 and server on 5555/5556 remain
running. Their compiled shared client/server hashes are unchanged. Full builds
were deliberately not written over those live outputs. The bank integration's
earlier isolated matched build and native Chrome/Metal views remain evidence
for that specific candidate, not for subsequently edited art or performance.

Local checkpoint receipts are in `/private/tmp/hyperia-checkpoint-20260920.U3UHVG/`;
bank/physical/native receipts remain in
`asset-studio/game-test-integration/bank-pavilion-integration01-UNQUALIFIED/`
and `bank-pavilion-art02-UNQUALIFIED/`. Temporary checkpoint logs are local,
not durable GitHub artifacts. The launch checklist and graphics reference
library retain the longer-lived qualification narrative.

All seven world-art acceptance tasks remain open. Shoreline accounting remains
**3 checked / 8 open**. Bank service dressing/ground integration, arena artistry,
whole-island composition, particle coverage, movement, streaming, transactional
banking and measured multi-agent performance still require their stated gates.

## Follow-up checkpoint — bank art03 and expanded island layout

The verified source slice adds post-mounted bank key signs and asymmetric
service wear. The admitted bank recipe is explicitly v2, with exact readiness
metrics updated together: 1,492 triangles / 247,200 bytes / three batches.
Historical smithy geometry and non-pavilion paths remain pinned. No runtime
asset is added; the paired asset revision above is unchanged. Candidate
`assets-v2` remains a local, non-promoted overlay, not a GitHub-backed manifest.

Verification: 13 geometry, 32 path, 35 visual/cutaway, 11 native-owner,
4 selected candidate-owner, 2 candidate-access and 37 client tests pass.
Counts overlap and must not be summed. Strict source typing, scoped lint and
eight isolated bundles pass; all 145 protected compiled artifacts stay exact.
The first access invocation skipped all cases without candidate opt-in; the
first client invocation matched no files. Correct invocations and failed
receipts are retained, not silently counted as passes.

Native01 timed out at startup before art evidence. Native02 passes the unchanged
gate and produces three real Chrome/Metal views with stable pins and complete
HUD leases. Signs/cutaway improve locally, but pavilion dressing, dark ground,
angular grass, whole-world composition, motion and performance remain open.
A 114.6 ms maximum grounding-slice receipt needs isolated pacing investigation;
it is not a controlled comparison or a proven cause of the earlier timeout.
Owned diagnostics and temporary database are cleaned; human localhost services
and database remain unchanged. The evidence is local, not committed media:
[art03 review](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/bank-pavilion-art03-UNQUALIFIED/README.md).

The launch checklist and art brief now require LAYOUT-01–08: a small pavilion
town, multiple functional banks, distinct mines, island-wide tiered resource
trees with rarer high tiers, skill-local quest NPCs, scattered rune altars,
a naturally shaped farther-inland pond, and integrated gameplay/art/performance
acceptance. These are all open, with the singular schema/path dependencies
recorded explicitly. No forbidden comparative brand is introduced.

## Follow-up checkpoint — bounded plural service ownership

Source-only foundation: a versioned `compactServiceCourts` layout supports up
to eight explicitly identified bank/smithy courts. Strict JSON admission rejects
unknown fields, duplicate bindings, overlapping roof envelopes, unsupported
rotations/grids and ambiguous primary banks. Every service binding is checked
against the actual station/NPC manifests before owners allocate resources;
startup cannot bypass this check through optional validation settings. The
current axis-aligned recipes are intentional, not arbitrary-rotation support.

Real test Worlds own three banks and a smithy: four native PhysX actors,
12 shapes and 16 independently released footing exclusions. Visual ownership
matches complete descriptors. Streaming bank readiness checks every admitted
bank, not just the primary; broken outlier physics or visuals fail it. Existing
primary paths stay byte-identical with additional stations and reordered court
records. New outlying paths and a finished placement graph are NOT authored.

The host/emitted-worker exclusion limit grows from 32 to 64 polygons, with
64 vertices per polygon unchanged. Eight courts plus 24 landscape exclusions
use at most 56 slots under the stated content budget. Full-cap cloning,
point/boundary queries and atomic over-cap rejection are tested. This is a
bounded admission limit, not measured GPU, loading or multi-agent performance.

A BankEntity open event/packet now names the actual runtime bank entity, not
its manifest alias. The new test uses a real World/BankEntity and checks event
identity only; it does not claim live socket delivery or ledger safety. Before
LAYOUT-02 can close, prove A-deposit/B-withdraw on the same authoritative ledger,
exact bank-session target/range/type and close revocation, concurrent/replayed
requests, restart/process-loss reconciliation, equipment transaction rollback
and agent discovery at every real bank. Existing custody authorities are not
rewritten or certified by this slice.

Post-recovery verification:

- 66 owner/visual/path cases across three suites.
- 41 surface-snapshot, 28 actual emitted-worker and one real bank-event case.
- 21 existing client readiness regressions.
- Strict source typing: 710 explicit/production roots, zero diagnostics, stable
  source hashes; separate client typing, scoped ESLint and Prettier also pass.
- All 145 protected procgen/shared/server artifacts retain their prior hashes.
  Localhost3333 responds HTTP200; its existing client/server/VM remain running.

The initial explicit typing command named a nonexistent worker-test path and
failed before checking; its corrected run exposed a structural method typing
mismatch, subsequently corrected and rechecked. The first worker command ran
only the 42 existing snapshot/event cases; a separate exact-path invocation
ran all 28 actual worker cases. Failed receipts remain retained. No new native
browser rendering, private build, whole-island route test, live banking round
trip, duration test or frame/memory acceptance is claimed. All eight layout
requirements and all seven world-art acceptance tasks remain OPEN.

### Verification incident and repair

A delegated test invocation improperly used unguarded `pnpm exec`. It
materialized dependencies, failed the root Node-version preinstall check,
replaced a preexisting untracked lockfile, and then mistakenly deleted that
file. This was disclosed immediately; it was not authorized cleanup.

The exact original 780,127-byte `pnpm-lock.yaml` was recovered from the earlier
verified workspace backup. SHA-256
`b5565add729a7d90dcf15c4a83f875b5cb76ebcff707eef74d78140b784122fc`
matches the pre-incident recovery inventory, and a byte comparison passes.
The lock remains untracked, as before; it was not regenerated or committed.

All 62 known root package links and 21 binary links were restored to recorded
Bun targets, including vendored r186 Three types. Replaced links/shims were
moved intact to local recovery evidence, not deleted. All restored targets
exist; scoped workspace links have no pnpm targets. Sixty-one backup package
manifests match resident targets byte-for-byte; the backup Husky manifest is
cloud-unavailable and was not hydrated. Its recorded link and resident target
were verified, not its unavailable backup bytes. Relevant verification above
was rerun after repair.

Residual pnpm cache/store/metadata and extra links remain untouched; no pristine
whole-dependency-tree restoration is claimed. The subtask also issued
`git fsck --lost-found`; neither the resolved common Git directory nor the
linked worktree Git directory contains a resulting lost-found directory.
No VM/debugger attachment, service restart, database mutation or dependency
install was used for repair. Local audit/mapping/repair receipts remain in
`asset-studio/game-test-integration/service-layout-network01-UNQUALIFIED/`;
they are not GitHub-backed runtime assets.
