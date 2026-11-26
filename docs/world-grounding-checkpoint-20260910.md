# World grounding checkpoint — 2026-09-10

**Probe03 spatial study PASS; outer run FAIL; complete grounding/art acceptance
still OPEN.** Common grading and model offsets correct ten station-base samples,
but the prayer altar retains a terrain discrepancy and outer process cleanup
failed. Probe01/02 remain evidence of the earlier failures and partial correction.
No result here is full visual, fitting, performance, stream or launch approval.
Keep all three evidence epochs unchanged.

## Probe01 — retained before-fix evidence

Local artifacts:
`/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/spatial-world-probe01`

Detailed local receipt:
`/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/spatial-world-review01/RESULT01.md`

| Artifact | Verified SHA-256 |
| --- | --- |
| `report.json` | `c4e9c744f5af3855875e45c9130bf04423ff7cba21449204de25807c2432843b` |
| `spatial-study.json` | `22284431030dde76623bf6ed11a3a0000011d0ae1e932d654fb0d65bac74d170` |

The actual two-agent maintenance preparation world ran in WebGPU at 1280 x 720,
DPR 1, with both provisional seven-slot kits. Report timestamps span 122.048
seconds (approximately 123 seconds observed), not a soak/performance gate.
Hashes, selected saved JSON values and all six ordinary spatial PNGs were
independently checked. Source pins stayed unchanged during that run.

## Probe01 — before-fix measurements

Forty visible terrain meshes were measured: 16 x 100 m, 12 x 200 m, 12 x 400 m;
all resolution 16. All 56 entity-node rays had finite rendered-triangle hits,
including all five required station types and the separately sampled origin.
Finite coverage is not height agreement.

| Station | Node minus rendered terrain (m) | Static base minus rendered terrain (m) |
| --- | ---: | ---: |
| Bank | +2.959828 | +2.700271 |
| Furnace | -3.974790 | -4.485260 |
| Anvil | -3.056086 | -3.173857 |
| Altar | +5.655082 | +5.515724 |
| Range | +0.146384 | -0.024979 |

Positive means above the sampled terrain; negative means below. Base deltas use
visible static CPU vertex bounds against the terrain hit at the entity center,
not every footprint point. Skinned/instanced/GPU-deformed geometry is excluded;
these are CPU-triangle measurements, not GPU readback or collision approval.

Measurements preceded the natural-daylight captures by approximately 66–68
seconds. The study did not repeat terrain identity/LOD measurements per capture.
Therefore the images are **not same-instant mesh/LOD evidence**, and camera/LOD
stability remains a required follow-up check.

## Probe01 — art verdict and retained errors

The actual images fail the desired quality bar:

- `spatial-bank.png` and `spatial-pond.png` show floating bank/altar geometry.
- `spatial-furnace.png` and `spatial-anvil.png` show terrain-only subject views,
  consistent with the measured burial.
- `spatial-tree.png` contains real trees, but elevated exposed roots, crowded
  scale/composition and saturated foliage remain unacceptable.
- `spatial-hub.png` and `spatial-pond.png` show weak, washed-out terrain/lighting,
  poor contact/shadow cues and an unconvincing disk-like pond/shore. This is not
  yet a polished compact preparation island.

The ordinary PNGs retain readiness/provisional UI. Separately named
`-UNDER-OVERLAY-DIAGNOSTIC.png` captures are not approved presentation evidence.
Placement findings must not be misreported as avatar texture or hand-fit fixes.

Zero page/GPU/failed-asset-HTTP/cleanup errors were recorded, but **14 real console
errors remain**, all the exact canonical `bronze_dagger` `missing_fit_metadata`
failure. The report explicitly says `errorFree: false`, `productionClean: false`
and `productionApproved: false`; the diagnostic classification is not a waiver.

Native-call tracing recorded 190,286 begin/end pairs and 22,522 finishes with no
recorded violations/errors. Cleanup verified 14/14 kit detachments, four private
CPU geometry disposals, one environment disposal, restored rendering/camera,
zero pending jobs and no active camera owner. The browser closed, launcher/stack
exited cleanly, and final checks found no listeners on 3333/5555/9236/57831. These
bounded receipts do not establish global memory-leak freedom or frame-time quality.

## Probe02 — central improvement, peripheral regression

Local artifacts:
`/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/spatial-world-probe02`

| Artifact | Verified SHA-256 |
| --- | --- |
| `report.json` | `53762abfbbc872ddf60c01b027c7c016c3a8c042793e815b1b664ec3d2004f12` |
| `spatial-study.json` | `02680bdcf600262b9f908c332ee8a51f4695458d33dd09c3b15ec8f561eac812` |

This second source-pinned run spans 122.704 seconds, from
`2026-09-10T16:57:14.401Z` to `2026-09-10T16:59:17.105Z`. It again records actual
1280 x 720 WebGPU/DPR 1, the same 40-mesh size/resolution distribution, and 56/56
finite entity-node rays. Both JSON hashes and the following values were checked
directly; this addition is not a new independent visual approval of probe02.

| Central station | Probe02 node minus terrain (m) | Probe02 static base minus terrain (m) |
| --- | ---: | ---: |
| Bank | +0.100000 | -0.159557 |
| Furnace | +0.531138 | +0.020668 |
| Anvil | +0.367382 | +0.249611 |
| Altar | +0.167860 | +0.028502 |
| Range | +0.115765 | -0.055598 |

The multi-metre central errors shrink, but this is not complete grounding:
the bank base remains below the center surface, the anvil base remains above it,
and the range base discrepancy worsens from -0.024979 m to -0.055598 m. A near-zero
furnace center/base delta does not prove footprint contact. All five central
nodes retain +0.100000 m relative to the client's sampled height, which is not
equivalent to the rendered triangles or each model's base.

Peripheral `runecrafting_altar` results expose the regression rather than
supporting a whole-campus success claim:

| Altar | Probe01 node minus terrain (m) | Probe02 node minus terrain (m) | Probe02 static base minus terrain (m) |
| --- | ---: | ---: | ---: |
| Air | +0.304261 | +0.985327 | +0.379252 |
| Mind | +0.988998 | +3.713262 | +3.107187 |
| Water | +0.030534 | +0.030534 | -0.575541 |
| Earth | -0.637451 | -0.637451 | -1.243526 |
| Fire | +0.206464 | +0.051376 | -0.554699 |
| Chaos | +1.203328 | +0.181727 | -0.424348 |

The authored pond-center sample at (-7, -18) is also unchanged: client height
26.600000 m versus rendered 26.674000 m, delta -0.074000 m. This one point does
not establish basin/shoreline shape. The study still measures before waiting for
natural daylight, without per-capture terrain/LOD resampling; the temporal
qualification limitation remains.

Probe02 again retains 14 actual canonical dagger fit-metadata console errors,
zero page/GPU/failed-asset-HTTP/cleanup errors, and `productionApproved: false`.
Cleanup records 14/14 detachments, four CPU geometry and one environment disposal,
zero pending jobs, restored rendering/camera, a closed browser and a clean
launcher/stack exit; final checks found the same four ports unused. No art,
performance, full combat-cycle or streaming gate closes from these counters.

## Probe03 — station-base improvement, residual terrain and cleanup failures

Local artifacts:
`/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/spatial-world-probe03`

| Artifact | Verified SHA-256 |
| --- | --- |
| `report.json` | `2315f9344ff0f1af4df58622040eadb4116563239d556b36774c7365c6095837` |
| `spatial-study.json` | `d411aca8d0ed1d6d4896c3fbb4ee1be5096d9a35c8017965900f9f74b1ef757a` |

The 128.518-second run records actual WebGPU at 1280 x 720/DPR 1, 40 terrain
meshes, 56 finite entity-node rays, and unchanged pinned sources. Eight study
views produced 16 spatial PNGs; their hashes were checked against the report.
The exact build ID is
`61b46aa5c5f43d99b4013b747b53111a37c8d8558244d7dd3cabd51b0a64176a`.

Common campus/pond grading and six model-offset calibrations produce these
**initial static-bounds measurements**, not a universal fit/contact approval:

- Bank, furnace, anvil, range and all six runecrafting altars: the model base is
  within `1e-6 m` of rendered terrain at the center and four footprint corners
  for each station (50 comparisons). Their entity nodes remain approximately
  +0.100000 m above the terrain; node origin and model base are not interchangeable.
- Prayer altar: model base is **+0.067860 m** at the center and up to
  **+0.153139 m** at a footprint corner. The coarse pond-adjacent terrain triangle
  still disagrees with the analytic grade. Changing the model offset alone must
  not conceal this residual surface mismatch.

Unlike probe01/02, each PNG now has before/after terrain-ray and geometry-identity
records with camera-render advancement. The 16 per-image brackets contain 32
snapshots covering station node
heights; they are not contemporaneous model-base/footprint remeasurements,
continuous LOD residency evidence, visible-pixel coverage or GPU readback.
`spatial-mind-altar.png` is occluded by tree geometry and cannot approve the
altar's visible presentation. The hub, furnace, prayer-altar and pond samples
show clearer station placement, but the sparse ground, crowded trees, weak
lighting/contact cues and disk-like pond remain below the desired art standard.

**Do not report this run as fully clean:** `studyPassed: true` and the inner
study's `passed: true` coexist with outer `passed: false`. `launcher.log` records
`game-client process-group inspection failed: kill() failed: EPERM: Operation not
permitted`; launcher exit was 1, and the outer report retains that cleanup error.
The game server exited 0, browser closed, final four port checks were empty,
14/14 visuals detached, four CPU geometries and one environment were disposed,
and camera/render state restored. Those narrower successes do not erase the
failed process-group inspection or prove all processes were cleaned up.

Zero page/GPU/failed-asset-HTTP errors and zero native trace violations/errors
were recorded, alongside the same **14 real canonical dagger fit-metadata console
errors**. Production approval and console cleanliness remain false.

### Source verification receipts

These are actual task execution receipts reported by the coordinating agent,
not invented retained stdout files or a new rerun by this document's author.
The commands used Bun 1.3.14 and Node 22.

| Gate | Command scope | Task receipt |
| --- | --- | --- |
| Focused tests | `bunx --no-install vitest run` on the 11 explicit terrain grading, quadtree, pond, station grounding, manifest, profile and material/uniform test files | Session `21420`: exit 0, 73 tests / 11 files, 1.84 s; Vitest start time 13:17:42 EDT |
| Types and builds | `bunx --no-install tsc --noEmit -p` for shared, server and client tsconfigs; then `bun run build:shared` and `bun run build:server` | Session `69192`: all sequential gates exit 0; build ID matches probe03 |
| Scoped lint/format | `bunx --no-install eslint` with `--max-warnings 0`, then `bunx --no-install prettier --check`, on the seven changed TypeScript files | Session `49272`: exit 0 |

The seven linted files are `StationSpawnerSystem.ts`, `TerrainSystem.ts`,
`TerrainQuadChunkGenerator.ts`, and the new `TerrainStationGrading`,
`TerrainQuadChunkGeometry`, `TerrainRadialPondGrading`, `StationModelGrounding`
tests. The focused suite additionally includes `TerrainWaterBodyManifest`,
`TerrainQuadTreeRootRadius`, `TerrainVisualManagerPacing`, `WorldTerrainProfile`,
`TerrainShader.materials`, `WorldIlluminationUniforms`, and
`RadialPondTerrainProfile` tests. These source gates do not override runtime or
art failures. The coordinating agent also verified the six model offsets against
actual GLB geometry with seven passing tests; this is separate from rendered
terrain agreement and does not close future asset-change or full-contact gates.

Paired runtime/source checkpoint:
`f191bddf32563df45bd623cd8e1d273615da54b4` on
`PlayHyperia/hyperforge:codex/sol-duel-stream-launch`.
Paired two-manifest asset checkpoint:
`233ba489fa97e72154fc8ab98060f4457dee8142` on
`PlayHyperia/assets:codex/duel-arena-launch-assets`.
Both are pushed and exact-remote verified by the coordinating agent, with GitHub
author/committer `dreaminglucid` and no post-commit secret-scan findings. All 63
probe03 input pins still matched after the game commit hooks.

## Follow-up: bounded shutdown diagnostics (2026-09-10)

The launcher shutdown helper now records bounded lifecycle and numeric-only OS
metadata for its original owned process handles when process-group inspection
fails. Every such error still fails shutdown, including EPERM if the group later
disappears. No discovered process becomes a signal target; command lines and
environment values are not retained. Observations are explicitly non-atomic and
do not establish historical close events or PID/PGID generation identity.

The coordinating agent reran
`/opt/homebrew/opt/node@22/bin/node --test scripts/duel-stack-shutdown.test.mjs`:
20/20 tests passed, zero skipped, in 5.061 seconds (session `12248`). This includes
a real self-restricted Darwin child returning EPERM, eventual natural child exit,
and the expected retained failure verdict. The contributing agent separately ran
all 20 tests with Bun 1.3.14 from `/private/tmp`; running Bun's test command from
the repository root exited 1 without diagnostics and is not reported as a pass.

This is diagnostic coverage, not an explanation or resolution of probe03's
natural EPERM. No replacement full-stack/GPU probe has passed from this change,
and the historical report remains `passed: false`.

## Remaining common-grade, vegetation and qualification work

An explicit vegetation limitation remains in the candidate: the 72 x 72 m campus
grade produces a 96 x 96 m procedural-grass exclusion through its blend area in
both synchronous and worker paths, as reported by the parallel source review.
This is not campus art acceptance. The compact-world follow-up must **separate
terrain grading from vegetation exclusion and make GrassWorker sample the final
authored grade**. Merely exempting the campus from grass exclusion would not
establish correctly grounded grass.

- [ ] Resolve the remaining prayer-altar/pond-adjacent triangle mismatch and
      repeat actual center/footprint agreement, including all peripheral altars
      and the pond, with contemporaneous model-base/footprint checks.
- [ ] Repeat independent model-root/base verification for new or changed assets,
      and qualify live whole-footprint contact; do not mask terrain-height
      mismatches with offsets calibrated to the wrong surface.
- [ ] Separate campus grading/grass exclusion and verify the synchronous and
      GrassWorker paths sample the same final authored grade before vegetation
      density, contact and performance qualification.
- [ ] Camera-motion/LOD transition checks, followed by actual daytime/nighttime
      station, tree, shoreline, scale, lighting and shadow review.
- [ ] Repeated complete error accounting and owned-resource/process cleanup;
      resolve the EPERM process-group inspection failure without suppressing it,
      and retain separate canonical dagger fit-readiness qualification.
- [ ] Representative performance measurements and longer-run combat/stream
      qualification before default promotion or production approval.

This documentation records runtime and asset checkpoints without promoting
unqualified defaults or closing the shared launch checklist's remaining gates.
