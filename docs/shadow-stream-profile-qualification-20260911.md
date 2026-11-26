# Shadow-enabled stream candidate — 2026-09-11

## Status

Implemented, CPU/build verified and observed in actual Chrome/Metal WebGPU,
**not visually approved or performance qualified**. The
explicit `shadows-720p60-v1` profile changes sunlight shadows only. It does not
promote a new default, make the world AAA-quality, or approve a broadcast.
The paired asset checkpoint remains `d6f52841f5d9173247e4499902ba1c27f96c2a89`.

## Workload and startup ownership

- Same 1280 × 720 drawing buffer, DPR 1, 60 FPS target and 4-sample MSAA as
  `canonical-720p60-v1`; same world selection, population and LOD policies.
- Uses the existing non-cascaded 4096 × 4096 sunlight map, PCF filtering,
  orthographic bounds ±200 m, near/far 0.5/600 m, bias 0.0002 and normal bias 0.01.
  These are existing settings under test, not an optimized shadow projection.
- Postprocessing, bloom, color grading, depth blur, water reflections and entity
  highlighting remain off. No private fill light or alternate material is added.
- Applies the broadcast policy before renderer initialization and again after
  loading stored preferences. Unrelated saves retain ordinary-user render values;
  the candidate is not persisted into them. Mid-session quality changes reject.
- Only non-embedded StreamingMode routes admit the new candidate. Embedded
  spectator/agent routes do not yet apply this startup contract and must reject
  it, including when `page=stream` would otherwise select the stream route.
- Both capture launchers preserve an explicit supported profile and require all
  navigation fallback URLs to select the same profile/FPS. Defaults are unchanged.

The application receipt reads existing renderer, sunlight, water and preference
owners. It requires actual render activity and shadow-map allocation; requested
constants alone cannot qualify. The server validates its shape and recomputes
the shared predicate. This proves configuration observation, not correct pixels,
GPU resource lifetime, frame time, full asset readiness or decoded broadcast.
The existing RTMP 180-second loading-overlay grace is not removed by this work;
do not equate shadow application readiness with complete scene readiness.

## Integrated verification

The first fresh client build failed: `src/index.client.ts` omitted the two new
runtime exports although the broader runtime barrel exposed them. This was a
real entrypoint defect, not stale output. The client-specific barrel is fixed,
and a regression imports that actual entrypoint. A separate review found and
closed the embedded-route scope mismatch described above.

After both corrections:

- Shared profile/client-entry tests: 44/44, two files.
- Client UI/preference/collector tests against the **built browser bundle**:
  48/48, three files. Source-aliased runs are additional, not substituted evidence.
- Server capture suites: 120/120, ten files.
- Existing Three patch/viewport-source ownership tests: 27/27.
- Shared, client and server typechecks pass.
- Normal client build passes: five dependency tasks (fresh shared build), then
  Vite production build. Fresh server build passes with competitive prefix
  `17edc5f9239d`. This is not a full-monorepo build claim.

These 239 test cases include CPU and existing UI transport fixtures. Actual
World/ClientInterface/localStorage tests prove startup persistence; an actual
uninitialized WebGPURenderer/Environment test correctly rejects unrendered state.
None substitutes for GPU rendering, shadows in motion, or production throughput.

## Actual canonical baseline — probe31

The frozen runner17 lightweight session ran from 04:36:27.368 to 04:38:50.692 UTC.
The spatial study passed, with 28 PNGs and 37 successful HTTP receipts. Root
independently verified all 337 current source pins, 268 archived sources, every
PNG digest and 1280 × 720 dimensions. Actual canonical application settings passed;
one Apple/Metal3, non-fallback rendering device was observed from creation with
zero uncaptured errors/loss. Zero GPU/page errors were recorded.

The complete run **failed**, retaining 19 cow/dagger console errors, the cow404,
and launcher exit1 from the recurring owned client process-group inspection EPERM.
The later OS snapshot showed the exact client leader as a zombie, followed by its
exit/close event; that is evidence of the shutdown/reaping race, not a waiver.
Browser/device-listener ownership cleanup completed and all four owned ports were
free. No unrelated process/container was stopped.

The two roughly ten-second visible/focused RAF windows completed with stable
resident counts. Post-equip p99/max were 16.7/26.5 ms; post-study 9.3/9.3 ms. These
are approximately 120 Hz **browser callbacks**, not 120 rendered/presented frames.
Each window observed 601 distinct cumulative render-call counter values, hence
600 increases: approximately 59.957 and 59.950 progress groups/second. The first
window advanced four internal passes per group; the second advanced three.
Three's animation owner increments `info.frame` before the application's
60 Hz pacing gate. Neither that counter nor internal pass totals is output FPS.
Both cameras moved naturally, and phase changed 0.1635→0.2054 / 0.4958→0.5386.
The post-study camera monitor remains installed. These are observed workloads,
not matched camera/light A/B measurements or deployment qualification.

Harness-specific startup retained a 1083.4 ms RAF gap. Endpoint JS heap readings
were approximately 3.42→3.51 GB after equip and 2.69→2.53 GB after the study.
They include the development build and diagnostic equipment owner; the large
footprint remains a concern, not production memory or leak proof.

Report SHA-256: `affe01841a7b3d826e2dd051b309ee50eccba3912c1d506451db6d9a88959efb`.
Spatial study: `46db1a185673c49c0a7af56547bf223a0348b25d196c4c447cebe31415d35d91`.
Presentation: `f5081b87a078546b39e7d0328547e586693f1b1506ee2fa6888839c75b5e7994`.
Full evidence is under local `asset-studio/game-test-integration/compact-world-probe31`;
the large capture directory is not made portable by this document.

## Actual shadow candidate — probe32

Frozen runner17 lightweight ran from 04:40:42.352 to 04:43:08.891 UTC against
the same built client and runtime source set as probe31. The spatial study
passed: 11 fixed views, 28 PNGs and 37 successful HTTP receipts. Root verified
all 337 current source pins, 268 archived sources and every PNG hash/dimension.
The applied receipt confirmed real rendering, 1280 × 720/DPR1/MSAA4, PCF
shadows and the allocated 4096² sunlight map with the requested projection.
It observed one non-fallback Apple/Metal3 rendering device, with zero recorded
GPU/page/uncaptured errors or device loss. Browser, listeners, launcher and owned
ports cleaned up successfully. The whole run still **failed** the 19 inherited
cow/dagger console errors and cow404. No error gate was relaxed.

Direct inspection of the daylight tree and hub images shows useful ground
shadows and stronger canopy depth. These are actual resource-tree batches, not
new decorative meshes. Fixed spatial camera poses match probe31. The tree view
has a 0.006 cycle phase difference (1.44 seconds), and exposure differs by only
0.000025; the hub phases differ by about 21 ms. This supports a visual comparison,
not pixel-identical lighting or a controlled shadow GPU-cost measurement.

The existing broad projection has not yet proved adequate for small characters,
tools or contact at every destination. The island remains a largely uniform
lawn, preparation trees crowd one another, structures lack coherent scale/art
direction, and the pond edge looks engineered. Night armor is dark, skin looks
gray/lilac and stream overlays obstruct important subjects. **These images are
not accepted as AAA-quality.**

The roughly ten-second scheduling windows remained visible/focused on the same
device with unchanged aggregate scene populations. Post-equip observed 594
render-progress increases in 10 seconds (59.4/s); post-study observed 600 (60/s).
Internal pass deltas differ with shadow work and are not displayed frames.
RAF p99/max were 24.9/33.2 ms and 9.2/16.6 ms respectively. Moving camera poses
differ substantially from probe31 (starting positions by 5.5–7.2 m and
orientations by 45.6–52.9 degrees), so these are **not matched performance A/B**.
Cold startup retained a 1025.1 ms gap. Heap endpoints were approximately
3.35→3.45 GB and 2.54→2.62 GB, with the same development/diagnostic limitations.
Lightweight collection does not prove native texture/encoder lifetime safety.

Report SHA-256: `c607d6269c409f25ab1ee3eace1b7b91c3932bc778c953aaf9f47ae397566ee2`.
Spatial study: `f7d7700a26b5e62110180ebc87f0a7aecf4c78269b6b6c3b5790eefc6b9feefb`.
Presentation: `7d70b0d6e6b88d7c067ed2030d64bf86e68ccf450c7035028e20c1b665b1b94a`.
Full local evidence: `asset-studio/game-test-integration/compact-world-probe32`.
Neither run selected a real broadcast/source epoch or qualified SOL wagering.

## Detailed native shadow diagnostics — probe33

The same frozen runner17 and candidate ran in detailed mode from
04:50:04.384 to 04:52:23.178 UTC. Root independently verified 337 current pins,
268 archived sources and all 28 PNG hashes/dimensions. The spatial study passed;
36 HTTP receipts succeeded (30 inventory actions, five bot polls and one
maintenance query). Variable bot polling is not a missing equipment action.
The whole run still **failed** the same 19 content errors and cow404.

Native tracing recorded 64,303 matched render-pass begins/ends and 31,985 encoder
finishes, with zero recorded violations or GPU/page errors. It retained 363
tracked textures, zero known destroyed-reference failures and no operation or
metadata errors. The bounded event ring dropped older event history; 11,648
unknown descriptors and untracked render-bundle/compute/external-texture sampling
remain limitations, not successful validation. This is bounded lifetime evidence,
not proof of all shader reads or in-flight GPU completion. All native wrappers
restored; the Node default-false descriptor stayed unchanged. Browser, launcher
and owned ports cleaned up successfully. No performance claim comes from this run.

Report SHA-256: `c72c77f45f65ff9c7fb0abb431b66e148787c34fe8280aab5c75f0d6d1974573`.
Spatial study: `8df6b15d3abdc404bdecb0c16e68ac1bf1e405baf0356680d548a88310f06d33`.
Presentation: `3f35cc8638e605dde881d78a3a79629edd9b15518734af9f4bfb32425d59df4a`.
Full local evidence: `asset-studio/game-test-integration/compact-world-probe33`.

### Concrete next corrections

Source inspection explains missing contact on the retained lobby and hospital
platforms: unlike the arena floor, these meshes do not opt into `receiveShadow`.
Avatar meshes cast but explicitly do not receive shadows. Qualify the floor
correction first and test avatar reception separately in daylight; night kit
captures do not establish daylight self-shadow quality. These are acceptance
gaps, not justification for arbitrary fill lights or stronger global AO.

## Remaining acceptance

- [x] Capture actual Chrome/Metal WebGPU canonical and shadow candidate runs with
  pinned builds/assets, actual applied receipts, fixed spatial camera poses and
  unchanged error gates. Preserve both whole-run failures; do not call them passes.
- [ ] Inspect contact, acne, detached shadows, foliage cutouts, camera motion and
  shadow coverage on terrain, avatars, gear, structures and resource trees.
- [x] Separate low-overhead frame-cadence windows from heavy lifetime tracing;
  retain cold loading and natural daylight waits as separate phases. RAF cadence
  is scheduling evidence, not GPU duration or encoded 60 FPS proof.
  A fresh application/browser session is not a guaranteed cold OS, Vite or GPU
  shader cache. The retained Node attestation imports the shared module early;
  initial navigation measurements remain harness-specific startup observations.
- [x] Run the shadow candidate with detailed native texture/encoder tracing,
  separately from scheduling observations; do not infer performance from tracing.
- [ ] Measure genuinely matched camera/light/population frame times, production
  memory, temporal shadows and the actual decoded stream before promotion.
- [ ] Fit useful shadow coverage and temporal stability after inspecting the
  existing 400 m-wide projection. More cascades are not automatically better:
  [Three's CSM implementation](https://threejs.org/docs/pages/CSMShadowNode.html)
  uses a separate shadow-casting light for each cascade.
- [ ] Finish terrain/shoreline composition, ground material variation, resource
  groves, lighting/material agreement and motion. Contact AO is a later measured
  experiment; [GTAO](https://threejs.org/docs/pages/GTAONode.html) has explicit
  sample/resolution costs and temporal-filtering artifacts to test.
- [ ] Resolve inherited cow/dagger content errors and qualify actual streaming,
  long-duration lifecycle, deployment hardware and representative population.

Probe30 remains detailed correctness evidence with heavy diagnostic overhead;
its residual render spikes are not established production hitches. Preserve all
old runners and captures unchanged when producing the new comparison.
