# Compact ground and pond checkpoint — 2026-09-10

Status: implemented and visually reviewed in actual WebGPU, **not art-ready**.
The terrain repetition/scale is improved. The island still reads as a bare green
model; this checkpoint does not satisfy the user's requested finished quality.

## Implemented scope

- Grass/dirt each blend two deterministically rotated/offset/scaled projections.
  Explicit gradients preserve mip selection across discrete pattern bands and
  drive the matching normal frame. Adjacent bands share the same projection at
  their boundary. Grass repeats .85/m, dirt .95/m instead of .3/m; bounded scale
  variation ±18%. Rock keeps existing triplanar .3/m sampling.
- Same six packed maps. Surface texture fetch sites increase **10 to 14**, with
  eight explicit-gradient sites. Existing distortion noise now wears the path
  margin; this may also retain one formerly dead control-noise shader sample.
  CPU/main/worker mean-ground colour weights match the worn-edge formula.
- Compact-only maple/magic exact `leaf` material palette targets muted copper
  #96534c and jade #4f7e77. Bark/bark2, alpha, maps, vertex AO, resource IDs,
  harvesting, wind and dissolve/highlight behavior are retained. No extra samples
  or geometry for this palette change. Other profile/species defaults unchanged.
- A five-model Blender kit supplies four boulders, six stones, eight ferns,
  three bushes and eleven reeds. The 32-instance layout uses five main-pass
  batches and 20,044 submitted triangles before culling. Shadows are additional.
  Five GLBs total 5,478,672 bytes; estimated texture+mip allocation is 22.609375
  MiB, not a measured GPU-memory value. Reeds are original vertex-colour geometry.
- New scenery owner preserves all model primitives/material groups/transforms,
  borrows cache geometry/material/maps, and disposes only instance resources.
  Terrain grounding uses current retained triangles, never an unrelated height
  approximation. Matrices/bounds refresh only when retained geometry changes;
  revision checks run at most four times/second. Missing/replaced surfaces hide
  their instances. Late loads cannot reattach after destruction.
- Rocks are constrained to already-underwater terrain inside the admitted pond
  footprint. A failing first stone placement was moved inward. Southern fishing
  bank and approach remain open; no new colliders, height or navigation changes.
  Pivot grounding is **not** all-footprint contact qualification on sloped banks.
- Launch asset preflight requires the exact five model hashes as well as the
  existing six terrain maps. Missing/stale fixture variants all fail correctly.

The kit comes from existing boulder/path stone/fern/bush assets, normalized and
texture-sized in isolated Blender CLI with official MCP inspection/roundtrip.
Original meshes/assets and the open dirty avatar scene were preserved. Source
shape error <=1.47e-7 m; roundtrip bounds difference 0 m. Source rights/provenance
remain an open launch gate. Asset checkpoint: `ecb25a0609f5ceecdec0f3a4160d3c3eafe271fd`
on `codex/duel-arena-launch-assets`.

## Actual browser evidence

Local evidence directory: `asset-studio/game-test-integration/compact-world-probe15/`
in the shared workspace, not included in the source Git push.

- Actual headful Chrome/Metal WebGPU, 1280x720, DPR1; 11 existing matched camera
  definitions, 22 scene PNGs plus six baseline PNGs. Paired files retain the
  original overlay; `UNDER-OVERLAY-DIAGNOSTIC` is explicitly diagnostic footage.
  Agents and incidental world activity are live, not identical pixel state.
- Start `2026-09-10T22:25:06.294Z`, finish `22:27:14.933Z` (128.639 seconds).
- All six maps and five GLBs received HTTP200, exact prelaunch hashes/bytecounts.
  172 source/art pins unchanged. All 45 initial/before/after material/terrain/
  road/water/pond observations complete. All32 scenery instances installed.
  The receipt's `visible` count means installed instances, not visible pixels.
- Inner spatial study passes, camera restores exactly and normal rendering resumes.
  Zero page errors or GPU diagnostic errors. Browser closed, launcher exits0,
  owned process groups gone, PostgreSQL stopped, ports3333/5555/9236/57831 clear.
- Overall run remains **failed**: existing cow VRM404 and canonical dagger fit
  errors persist. Nineteen console errors were retained, fourteen exact dagger
  messages and five cow/HTTP errors. This run does not erase the earlier probe13
  intermittent process-group shutdown failure or qualify streaming/launch.

Evidence SHA-256:

| Artifact | SHA-256 |
| --- | --- |
| report.json | 0f48ad1a6523c38c9d5b88b0b05605c5340a5e0c502f11e420341909ddcfb048 |
| spatial-study.json | a3fdeeeae0d1fbcec17c65dca977e789d8c8460bd3bd9ebcf644722eb90186bf |
| launcher.log | e43c2b3261a214e9835a814edb859232e718f26ff5667cc2ccdafa0156b897c4 |
| build ID | 70349c4b2300e6f695d9afef078d19bb781d7ae7129896d2d31c932dcc5220ed |

Immutable runner05/study10 preserve previous camera/ownership/teardown gates and
add intentional fourteen-sample admission and exact five-model delivery checks.
Older captures, scripts and tests were not overwritten.

## Verification and honest art verdict

540 shared tests/42 files, 128 server tests/nine files, 17 launch-preflight tests,
37 study tests and six art-pin tests pass. Shared/client/server typechecks, scoped
lint/format, lossless terrain packing validation and fresh shared/server builds
pass. These are development safeguards, not visual or performance sign-off.

Independent and primary review of probe14/15 pond/hub/island-wide images agrees:
the obvious turf grid is largely gone; paths have sensible smaller stone scale;
overhead lighting remains correct. New kit is visibly present with preserved
cutouts, but **the scene still fails the art target**. Dark rocks, bright pale
stones, mint ferns and saturated bushes read as separate samples. The basin has
a continuous pale circular rim; path ends remain smooth ribbons. Wide views are
too empty and uniformly green. Incidental bright houses still clash with the
world. No all-footprint contact, close foliage/wind, moving-camera frame-time,
multi-agent load, night or production-stream quality claim is made.

## Next implementation acceptance

1. Unify the pond bank: irregular wet-soil/shallow-water transition breaking the
   pale ring, then regroup/recolour the existing pieces into coherent asymmetric
   habitats. Preserve actual fishing markers and approach access. More instances
   alone will not solve it; recheck contact across complete footprints.
2. Give the compact island deliberate landform/coast/material regions and a
   coherent architectural setting for the stations. Remove the empty-lawn look,
   with no return to a large playable island or unbounded procedural population.
3. Qualify moving-camera/day-night readability and CPU/GPU/loading/memory cost
   with the real agent/stream workload. Keep avatar/gear, hospital stripes,
   missing cow/dagger content and the larger agent/SOL/stream checklist open.
