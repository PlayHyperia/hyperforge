# Denser meadow: verified trial, unfinished visual result

The opt-in `island-meadow-720p60-v1` render profile selects `compact-meadow-v2`
grass. It increases placement density from 2.8m to 1.75m spacing without
changing the existing island/default broadcast selections, blade geometry,
material, shadow policy, range or rendering quality. This is not promotion to
the default experience, whole-world art approval or production readiness.

## Actual result

Native Chrome 152 / Metal / Apple M5, nonfallback WebGPU, 1280×720, DPR 1,
MSAA 4 and the existing 4096px sun shadow map:

| Measurement                 | Original density, clean repeat | Dense trial |
| --------------------------- | -----------------------------: | ----------: |
| Retained clumps             |                          2,275 |       5,798 |
| Root-correction bytes       |                        218,400 |     556,608 |
| Completed terrain owners    |                              6 |           6 |
| Failed/pending fitting jobs |                              0 |           0 |
| Total active fitting slices |                        473.0ms |     811.6ms |
| Maximum fitting slice       |                          5.4ms |       4.7ms |

The last two rows describe cooperative loading work, not per-frame steady-state
cost. The 2ms target still has overshoot. These runs are not a controlled
speedup benchmark: live actors and natural lighting time differ. An earlier
baseline run also overlapped CPU tests and is explicitly ineligible for a
clean performance comparison. No result or error was discarded.

Dense-scene ten-second instrumented windows recorded p95 CPU client ticks of
17.7ms (campus) and 15.1ms (meadow), and p95 render/compute GPU-pass sums of
19.14ms and 21.76ms. These are **not presented FPS or total GPU wall time**;
they do not qualify the full scene for stable 60 FPS. No density, resolution
or shadow downgrade was used to conceal the cost.

## Visual verdict

Direct review covered all eight world views, the baseline overview and the
temporary outcrop composition. Pond-side coverage is visibly fuller. The
preparation foreground remains too sparse, blade shading reads flat/bristly,
and the distant terrain still looks airbrushed with synthetic ridge forms.
The density increase alone is **not the requested quality jump**.

Same camera/quality, separate native daylight runs; actors are not frozen:

Original density:
![Original pond-side grass](evidence/dense-meadow-20260912-before.png)

Dense trial:
![Denser pond-side grass](evidence/dense-meadow-20260912-after.png)

Next: diagnose the distribution around the preparation area, improve curved
blade/soft-normal shading and coverage transitions, then retest moving views
and actual GPU cost. Terrain, large geology, sky, lighting, water, buildings,
asset fit/animation and soundscape remain separate unfinished tasks. Do not
raise caps or claim AAA quality to make a candidate pass.

## Grounding and verification

Cheap float validation now yields per bounded 32-value block; the fade/wind
envelope yields per blade, at most fourteen transforms. Every original
geometric work charge and arithmetic operation stays in order. Cancellation,
terrain/constraint epochs, triangle contact, exclusions, upload pacing and
existing hard work/time limits remain. The resumption counter is explicitly
different from the receipt's geometric work counter.

- 1,230 shared tests across 90 files pass, including both render-profile
  admissions, historical placements, lifetime/invalidation and grounding.
- 19 external tests compare the untouched original numerical algorithm with
  the current production core/worker inputs at both densities and all LODs.
  Only elapsed time is excluded from the preexisting result-field comparison.
- 22 capture preflight checks; shared/client/server builds and typechecks;
  scoped ESLint/Prettier and diff whitespace checks pass.
- Native render study passes with all 5,798 clumps; **overall report fails** on
  the existing five missing-cow and fourteen dagger-fit metadata errors. No
  new page/GPU/cleanup errors. All owned browsers, launchers and ports closed.
- 679 source pins and 600 source archives verified for the dense run, plus
  all 16 required image artifacts. Its report SHA-256 is
  `fb59fc94ab85cd303e161f63f46d61e418734d743ee026cca8f61299a492198f`.

Local evidence is retained under
`asset-studio/compact-grass-grounding-integration01/batching01/` and
`asset-studio/game-test-integration/dense-meadow-native01/`.
`batching01/verify.mjs --check-only` verifies the archived runs and exact dense
source delivery. Older run source hashes intentionally differ after the
separately captured profile addition; their original archives remain intact.

[AMD's procedural grass research](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/)
informs the next shape, normal and density-transition work. Its native mesh
shader implementation is not a WebGPU feature claim or a drop-in replacement.
No third-party plugin/code was imported in this pass.
