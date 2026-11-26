# Denser meadow: verified trial, unfinished visual result

## Subsequent terrain-noise candidate: rejected

A two-scale fresh/dry colour experiment reused the existing fine noise sample
to break up the broad meadow field, with matching CPU/worker and TSL arithmetic.
It added no textures, samples, geometry, lights or passes. All 1,237 candidate
shared tests, 24 grounding-reference checks and builds/typechecks passed.
Nevertheless, direct review of all eight native world views **rejects the
candidate**: fine mottling does not resolve painted-looking ground or the weak
landform, vegetation and architectural composition. Its four source/test changes
were removed; the pushed curved-grass checkpoint remains selected.

The exact rejected patch, reports and archives are retained in
`asset-studio/compact-grass-grounding-integration01/field01/`. Before restoration,
679 candidate source pins, 600 source archives and 16 PNGs were verified. Native
Chrome/Metal/nonfallback WebGPU retained the same rendering quality and 11,652
clumps. Focused study passes; the overall run still fails the same 19 cow/dagger
errors. No page/GPU/cleanup errors; owned test browser/launcher/ports closed.
Report SHA-256:
`3849ccf107d64e1d29ca36ca1df4020d04cf934d7a13c0848e1ad9cf639d9e2b`.
Its p95 CPU ticks 10.8/10.0ms and GPU-pass sums 13.70/15.01ms are not presented
FPS, full GPU wall time or sustained full-population qualification.

Return to the [finished-scene brief](compact-island-environment-art-brief.md):
pond–workshop–arena composition, grounded rock/understory groups, worn interaction
areas and articulated architecture. Avoid another generic whole-island tint pass.
[Height-based material blending](https://dev.epicgames.com/documentation/unreal-engine/landscape-material-expressions-in-unreal-engine)
needs actual material-height inputs and nonzero contributions; the current
albedo/roughness and normal/AO packing does not contain an independent height
channel. This rejected colour experiment is not that technique.

## Curved blades and soft lighting checkpoint

The explicit dense comparison profile now uses shorter quadratic blades,
smooth derivative normals and two-sided terrain-aligned soft lighting.
It retains the same topology, geometry-buffer bytes, instance attributes,
placement density, LOD, range, shadows and resolution. No texture is added.
Original compact and ordinary/fixed-arena geometry remain byte-stable.
Normal yaw/tilt happens per vertex; face correction and the soft blend happen
per fragment. This is a deliberate approximation, not complete plant
transmission or exact normals under all wind/fade/root-correction deformation.

Native Chrome152 / Metal / AppleM5, nonfallback WebGPU at 1280×720, DPR1,
MSAA4 and existing 4096px sun shadows installed **11,652 clumps** and
**1,118,592 correction bytes** across six complete owners. All eight world
views were directly reviewed. The shorter curved silhouette is an incremental
improvement, but the sparse/wiry blades, airbrushed ground, synthetic ridges
and inconsistent foliage/building materials still fail the requested quality.
This comparison profile is not promoted to the default experience.

Same camera and rendering quality; live actors/lighting time are not frozen:

Before curved appearance:
![Previous meadow blades](evidence/campus-meadow-20260912-after.png)

After curved appearance:
![Curved meadow blades](evidence/curved-meadow-20260912-after.png)

1,236 shared tests / 90 files, 24 checks against the untouched original
grounding algorithm, 22 native preflights, all three builds/typechecks and
scoped lint pass. Curve geometry, roots, buffer layout, tangent/unit normals
and actual TSL arithmetic are checked; an independent quaternion oracle covers
three slopes, four rotations, three views, both faces and three blade normals.

Native study passes, **overall report remains failed** on nineteen existing
cow/dagger errors. No new page/GPU/cleanup errors; owned browser, launcher and
ports closed. All679 current source pins,600 archives and16 PNGs are verified.
The baseline opening frames retain loading overlays and are not visual approval.
Report SHA-256:
`ee40a20a2889ad9293935e351bcbecc832213df5efeba640b0b5cfe43992095b`.
Evidence and verifier:
`asset-studio/compact-grass-grounding-integration01/curves01/`.

Active fitting totaled614.7ms with a5.9ms maximum slice, still overshooting
the2ms target. Ten-second campus/meadow p95 CPU ticks were10.8/9.4ms and GPU-pass
sums13.83/15.20ms. These are not presented FPS, full GPU wall time, a controlled
speedup benchmark or stable full-population60FPS qualification.

[AMD's grass research](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/)
informs curve/normal principles; [Three NodeMaterial](https://threejs.org/docs/pages/NodeMaterial.html)
and installed r186 source supply the actual node semantics. Native mesh shaders
are not claimed as a browser feature. Next: coherent ground-material coverage
and vegetation integration, then moving-view/lighting/contact and cost checks.
G04 and the overall AAA/reliability goal remain OPEN.

## Campus clearance and spatial-query correction

The broad `duel_arena_campus_grade` blended across X292–444 / Z324.5–457 and
implicitly excluded grass, including the southern preparation meadow. Its
grass exclusion is now explicitly false. Real arena, lobby, hospital, lodge
and station clearances remain; the grading height, roads and resource layout
do not change. This one-line manifest change belongs to the separate assets
repository and must accompany the game-side grounding optimization.

Restoring coverage initially exceeded the dense profile's existing work cap.
Grounding now conservatively filters base-query terrain surfaces and indexes
road capsules into a bounded 8×8 grid. Shared-edge ordering, exact triangle and
capsule predicates, complete swept coverage, cancellation and all hard limits
remain. The original arithmetic outputs match; the work counter now records
fewer irrelevant tests. No density, detail or quality reduction was made.

The new native run installed **11,657 clumps** / **1,119,072 correction bytes**
over six complete owners. Loading fitting took 630.5ms in active slices with
a 5.3ms maximum slice, still above the 2ms target. Actual ten-second p95 CPU
ticks were 13.1ms/10.6ms and GPU-pass sums 18.35ms/16.45ms for campus/meadow.
These are not presented FPS, full GPU wall time, a controlled before/after
speedup benchmark or stable full-population 60FPS qualification.

Native Chrome/Metal/nonfallback WebGPU retained 1280×720, DPR1, MSAA4, existing
shadows and 1.75m spacing. Study passed; overall failed on the same 19 cow/dagger
errors. No new page/GPU/cleanup errors. All owned test browser/launcher/ports
closed. All eight world views were reviewed; missing coverage is visibly
fixed, but flat/spiky blades, synthetic terrain and basic lighting/building
materials still fail the requested visual standard. Opening baseline images
retain their loading overlays and are not used as world-view approval.

Same meadow camera before the clearance correction:
![Before campus grass clearance](evidence/campus-meadow-20260912-before.png)

After the clearance correction:
![After campus grass clearance](evidence/campus-meadow-20260912-after.png)

1,233 shared tests / 90 files, 24 external tests against the untouched original
core, 22 native preflights, all three builds/typechecks and scoped lint pass.
Large leaves are independently reconstructed from bounded original-reference
partitions; production remains one bounded job, without increasing its caps.
Historical fixture inputs are reconstructed explicitly and old census oracles
retained. New tests cover road/grid/terrain boundaries, exterior wind sweeps,
exact current worker counts and unchanged sampled heights/protected pads.

Native report SHA-256:
`94838871037d870f42ceb2eeabcb3aee141bbe47934575e99fa24f1e078b7017`.
`asset-studio/compact-grass-grounding-integration01/campus01/verify.mjs --check-only`
checks 679 current source pins, 600 saved source archives and all 16 PNG
artifacts, plus the previous dense baseline's immutable report/archives.
Initial work-limit/test-fixture failures are retained with their explanations.

Next visible pass: curved blade shape and coherent soft normals, then native
moving-view, shading/contact and cost checks. The [AMD grass research](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/)
provides useful curve/normal/LOD principles; its native mesh-shader code is not
a browser feature claim. G04 and the AAA goal remain OPEN.

## Earlier density-only checkpoint

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
