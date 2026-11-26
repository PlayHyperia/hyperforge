# Grass substrate: matched native timing — 2026-09-22

## Decision

**Incremental GPU cost is inconclusive.** Keep the existing opt-in visual
candidate; do not promote it to the default or call its two added reads free.
No production-source changes were made for this experiment.

The mean of the two run medians changes by **+0.05 ms** for the GPU envelope
and **+0.66 ms** for the terrain-containing main pass. Repeated-baseline
variation is **1.64 ms / 1.67 ms**, respectively; repeated-candidate variation
is **1.02 ms / 0.82 ms**. The directional before/after differences change sign.
This experiment cannot cleanly separate the small change from observed
variation. It is not evidence of sustained smooth performance or launch readiness.

## Four matched runs

All times below are milliseconds. Brackets show Q1–Q3 using interpolated
quantiles; every valid sample remains included. CPU figures include the
timing instrumentation and are not complete game-update times.

| Run | Saved build | Samples | GPU envelope median [Q1, Q3] | Terrain-containing pass median [Q1, Q3] | CPU render median |
| --- | --- | ---: | ---: | ---: | ---: |
| A1 / native137 | build68 | 12 | 33.39 [32.90, 36.04] | 17.86 [17.35, 18.22] | 5.60 |
| B1 / native138 | build69 | 12 | 32.11 [31.18, 33.52] | 17.27 [16.70, 18.51] | 5.10 |
| B2 / native139 | build69 | 12 | 33.13 [31.64, 33.73] | 18.09 [17.35, 19.02] | 5.25 |
| A2 / native140 | build68 | 12 | 31.75 [30.15, 32.90] | 16.19 [15.99, 17.48] | 5.25 |

A is the previous material; B adds the existing frequency-v1 grass RGB
substrate treatment. Its static terrain sample sites increase 33 → 35.
Both use the same seven texture maps and unchanged resolutions, mip chains,
roughness, height, normals, AO, soil, rock, geometry and populations.

The comparison is equally weighted across the two run medians, not pooled
as 48 independent experimental replicates. Envelope B1−A1 = −1.28 ms and
B2−A2 = +1.38 ms. Mixed-main B1−A1 = −0.59 ms and B2−A2 = +1.90 ms.
Four runs do not support a significance test or a confidence claim.

Capture start times in EDT: 21:12:44, 21:15:08, 21:17:06, 21:18:50.
Each capture took about 64 seconds; gaps were unequal. A–B–B–A does not
eliminate nonlinear drift, background activity or shader-cache differences.

## What was actually held constant and checked

- Source checkpoint: `20de602e0ad521a9fa89043078a49a64ca4d4202`.
  Both immutable build reports, all 18 bundles, identical 1,096 input path sets,
  all current inputs and build configuration were verified before and after.
  Only the two exact historical terrain-material source hashes differ.
  No source rollback, rebuilt baseline or canonical-output overwrite.
- Four native136 camera poses; full per-chunk grass population and complete
  flower placement/geometry receipts. Landing: 79,650 grass instances and 135
  flowers. No density, resolution or detail reduction.
- Chrome/Metal native WebGPU, 1280×720, DPR1, fixed daylight phase .56.
  Chrome's GPU inventory reports Apple M5. This is one host, not a device matrix.
- Original 90-second startup and 30-second camera readiness limits; no added
  settling or forced frames. Each capture completed all four views.
- Landing held for 12.001–12.009 seconds before its screenshot, with earlier
  video recording inactive, tracks stopped and encoding complete.
  Timing uses ordinary render frames without queue draining, world-clock
  writes, screenshots or video recording during the hold.
- Each run retained 12 usable timestamp samples. All raw query-pair indices,
  nonzero ordered timestamps, numeric durations, envelopes, complete draw
  accounting, owner identity, camera and renderer settings were checked.
  Sample gaps stay within 1,000–1,018 ms; no retrospective sample trimming.
- All runs: 22 actual terrain-owner draw calls in the mixed main pass.
  A1/B1/A2 have 189 reported main-pass draws and 2,043,065 triangles.
  B2 has 191 draws and 2,043,097 triangles. This small scene-work difference
  is retained as a comparability limitation, not hidden or cost-adjusted.
  Independent raw-row review identifies two additional `FishingSpotGlow` rows,
  one per side, 16 triangles each; all other retained main-pass rows match.
  The records lack entity IDs, so the exact fishing spot/cause is unknown.
  Their GPU contribution is not assumed negligible or subtracted.
- 13 nominal host samples per run. AC, lid-open and awake display checks pass.
  Spotlight background activity was observed before the sequence; nominal
  thermal category does not mean fixed clocks or exclusive host use.
- All four browsers closed; runtime107–110 stopped cleanly and their owned
  temporary databases were removed. Normal localhost:3333 returns 200;
  persistent player/database, 145 protected compiled outputs and lock remain intact.

## Instrumentation limits

GPU pass intervals can overlap; they are never summed or subtracted as
exclusive costs. The terrain-containing pass also draws other world objects.
It is not isolated terrain-shader time. GPU envelope is not presentation FPS.

The CPU window includes query allocation and synchronous renderer work but
excludes much of the world update and asynchronous readback. RAF observation
medians 16.6–16.7 ms are also not presentation-FPS or smoothness approval.

The helper samples approximately once per second and can skip while two
readbacks are pending; it does not expose an attempted/skipped counter.
Owned hooks, query resources and error listeners were restored/removed.
Stock renderer timestamp tracking remained disabled.

Fourteen private preflight/contract tests passed. They cover actual
read-only frozen-source verification, in-memory third-source and bundle
corruption rejection, wrong runtime/build admission before output creation,
material identity versus name collisions, overflow/accounting, cleanup and
the 10-sample/exactly-one-main-pass gates. Mock timing tests are not GPU evidence.
Independent reviewers checked the frozen capture changes and analysis method.

## Reference-led next work

The [Grassworks demo](https://grassworks.techredux.co/demo) was visually
inspected in a temporary browser tab, then closed before measurement.
Useful visual cues are curved pointed silhouettes, longitudinal detail and
a darker lower canopy. Its displayed FPS is not comparable to this experiment.
No commercial source or assets were imported.

[Grassworks blade controls](https://grassworks.techredux.co/docs/grass/blade)
separate blade dimensions/bend from detail.
[AMD's procedural-grass article](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/)
provides curve-derived normals, length-aware bending and root-shading concepts;
its mesh-shader implementation is not a drop-in Three.js/WebGPU feature.
Our generator already has quadratic centerlines and analytic normals.

The current seven-vertex blade still has 84% root width at 80% of final
height, then tapers sharply to a point. Smooth normals cannot remove that
polygonal silhouette. A proposed physical folded cross-section would need a
new versioned layout, normals and full-face grounding/road/wind clearance;
its seven-vertex/six-triangle option also sacrifices longitudinal resolution.
It is a conditional design candidate, not an approved implementation.

- [ ] Improve blade silhouette, longitudinal surface detail and canopy-ground contact.
- [ ] Improve bright, smooth pond-side turf transition without hiding real shoreline issues.
- [ ] Inspect ordinary grazing-angle traversal, LOD/fade and wind in full motion.
- [ ] Establish broader target-device, sustained frame/memory and gameplay/stream acceptance.
- [ ] Re-measure changed geometry/material work; no default or production promotion yet.

## Evidence

Private evidence root:
`asset-studio/game-test-integration/inland-pond-integration01-UNQUALIFIED/`

- Immutable native137–140: process, scene/material/shader, still, wind and
  `landing-held-native-timing.json` receipts; runtime107–110 cleanup reports.
- `substrate-timing-abba01.json`: validated per-run statistics, contrasts and raw
  timestamp/draw rows. SHA256:
  `acc7a79de8a6e836c4ec259d21a8d7c86cf8a7beda4f126e0616f13d90c23388`.
- `analyze-substrate-timing-abba01.mjs`, `grass-shape-research01.md`,
  `native-pass-timing-contract.test.mjs`, `substrate-timing-preflight.test.mjs`.
- Check logs under the sibling `service-layout-network01-UNQUALIFIED/`:
  `grass-substrate-timing-preflight01` and `grass-substrate-timing-analysis01`.

No new visual-quality improvement, motion approval or production-source
implementation is claimed by this diagnostic checkpoint.
