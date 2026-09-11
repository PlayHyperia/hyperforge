# Connected landscape surface regions — candidate, 2026-09-11

## Scope and visual target

This follows pushed runtime `cf3212ddcaa0441ff316ce1692d1b453a83e8db8`, documents
`182e99ff4b1f2f0d160cafa936c3ce69faf7785c`, and asset profile
`d50abdadd50df4dd704bf9a03a20410f2e7dd559`. Probe40's actual wide view still looked
like a uniform green carpet. Numerical geometry approval was not art approval.

The [generated concept](art-direction/compact-island-20260911/PROMPT.md) guides
material and landscape hierarchy only. It is not an implemented engine render,
performance benchmark or authoritative prop/layout plan. This slice is a connected
straw/sage ridge shoulder and exposed western rock, keeping central preparation
ground greener. It does not add the concept's rocks, foliage, tents or buildings.

## Implementation boundary

- Derive a detached, immutable color field from the admitted v3 island center,
  radius and curved ridge spine/width/end-fade parameters. Do not change height,
  world bounds, profile identity, collision, routes or resource identities.
- Use the existing noise only to soften the broad shoulder boundary. Exposed
  western rock still depends on actual geometric slope, not a painted contour.
- Tint grass diffuse toward muted straw, blend up to 22% existing soil in the
  shoulder and reuse the existing rock layer. Pond soil/wetness and full path
  influence retain their final ordering and original colors.
- Use the same self-contained factory in the main CPU palette and actual grass
  worker. Cache the main field per TerrainSystem lifetime; derive it once per
  worker job. Update RGB only, not grassWeight, RNG, counts or admission rules.
- Keep six texture maps, 14 surface fetches, all geometry/population, light,
  environment, exposure, shadow configuration and rendering passes unchanged.
  Extra field work is one sine, four field smoothsteps, one slope smoothstep and
  bounded blending. Roughly 100 scalar ALU operations is a conservative source
  estimate before compiler optimization, **not measured GPU cost**.

The southwest preparation edge is not a mathematically exact exclusion. The
magic-tree anchor (318.5,344.5) receives approximately 6.68% dry weight; furnace/
anvil transitions are much smaller. This continuous taper is retained deliberately.
Do not claim that every preparation pixel is unchanged.

## Regressions and independent numerical review

Normal shared, client and server builds pass; shared/client/server typechecks pass.
Fresh server competitive manifest prefix is `88a19da9a389`. Root targeted
regressions pass 109 cases across 15 files: 100 shared cases across 14 files and
nine actual server support cases. The implementation agent's 46/7 suite overlaps
these and is not additional unique coverage. Scoped lint/format/diff checks pass.

Checks include continuous field boundaries, translated/scaled admitted coordinates,
malformed input rejection, actual TSL arithmetic, grass/main RGB and surface
parity, unchanged ecology, texture ownership and fixed pond/coastal geometry.
A freshly bundled/minified factory runs 75 samples in a real isolated Node worker.
These are not fake GPU renderers or visual acceptance tests.

An independent oracle uses the actual admitted World/Terrain/Roads at 48 world
coordinates: ridge cross-sections, workstations, pond/bank samples, six canonical
path midpoints and seven resource-tree anchors. Its 288 scalar CPU/actual-TSL-node
comparisons differ by at most `3.3306690738754696e-16`. Six path midpoints and five
pond samples retain exact previous RGB. Fifteen source pins remain stable.

Both independent pixel scans check all 1,048,576 pixels in the pinned grass
albedo map. At full new dry tint, maximum linear RGB is
`[0.6488134513169426, 0.3109451843382372, 0.20857153281761762]`, with zero channels
above one. This bounds reflectance, not final displayed tone or shader execution.

Oracle: `asset-studio/game-test-integration/terrain-macro-field01/oracle01.mjs`,
SHA256 `ae506a6d0ae06eec2afcb0c0234802d960f1c407af66dce749292962005e0051`.
Report: `report01.json`, SHA256
`b043e3106b523a2449c2577af39008b03079c7188c8327f846c418d32253864a`.

Frozen runtime SHA256 values:

| Source | SHA256 |
| --- | --- |
| CompactTerrainPalette.ts | `f103d8c632e555842fde66fa4391abf454ccb3581541a86050fe08ba7f45f0e4` |
| CompactTerrainMaterial.ts | `025e76a1462388fa31391ede6724c0599f86409c0c68fee96ada9f72bf505b82` |
| TerrainShader.ts | `d270e96d07c92e82f3c9633da5436fe851e6511544cbba999065504f1e6e4469` |
| TerrainSystem.ts | `467e8ae80f31666f4f12730b23078a142d97d7dac16f4520a7995c24959a6733` |
| GrassWorker.ts | `a80b24b119958bcc117b301f6a0d956318f33b9d31eaba60b973f10ee108c36b` |

## Actual capture gate — probe44 study passes; production and art remain open

Run actual headful Chrome/Metal WebGPU with the same explicit 720p/DPR1/MSAA4
shadow profile. Retain all original stream screenshots and under-loading-screen
diagnostics. Add separately labeled no-2D-stream-HUD screenshots; the owned style
lease must hide only the actual HUD/loading DOM and restore exact owners/styles/
layout afterward. Do not hide any 3D content or claim those images are UI-free:
the provisional observer badge remains outside the hidden HUD.

The previous apparent black northern building was the fixed countdown HUD. This
was a visual misidentification, not a building-material defect. Improved evidence
must prevent another overlay/world mix-up.

Probe42 captured the material in actual Chrome/Metal with no GPU/page errors,
but its study fails the new HUD helper's qualification. All eleven installations
immediately saw 68 visible DIV descendants because their existing `all 0.2s`
transitions had not settled. Eight restoration snapshots likewise saw visibility
still transitioning; identities, rectangles, inline styles, opacity and display
were stable. All owned styles and remote handles were removed. The source tool
mistakenly described the inventory rectangles as inside the 3D canvas; they are
actual transitioning HTML HUD descendants. Preserve the failed evidence. A
versioned helper will await bounded visibility settling before both measurement
and restoration, without disabling transitions or relaxing ownership checks.

The retained report SHA256 is
`ca7a89d4e248c9612ba17c719e504766a25622574ed4a6a9738de4e4f4e379a0`.
All 407 source pins, 338 archived files and 39 expected PNGs verify; an additional
failure screenshot is retained. All 67 individual observation boundaries completed,
but the HUD assertion ran before aggregate qualification and wrapper-after checks.
Those later gates did **not** pass. The post-equip timing window includes a
1,382.6ms application-progress interval; its approximately 41.00 positive
render-counter groups/second is not presented FPS, GPU timing or a matched A/B.
Do not omit that stall when discussing smoothness.

Successor lease02 awaits actual visibility using native animation frames and a
shared 450ms hide/restoration deadline. It changes neither native transitions nor
the identity, layout, inline-style, display, opacity or canvas assertions. Root and
independent review accepted the code. The current inherited harness suite passes
118 tests. An initial unfiltered invocation also ran the explicitly retired
eight-floor fixture and failed its `3 !== 8` expectation; the current three-floor
replacement passes. That historical fixture is excluded by exact test name, not
silently changed to make the suite pass.

Probe43 stopped before browser/service creation: preserved historical source pins
exceeded the equipment closure audit's 400-file cap. No material or native CSS
result was produced. A versioned audit will admit at most 512 pins while retaining
per-file hashes, source-size limits, parser checks and exact runtime revision
checks; boundary tests must retain rejection beyond that finite limit. The actual
live successor is probe44. Its actual prelaunch closure contains 407 pins; the
full executable audit passes, including all revision/parser and closed-owner
checks. Root also passes the full successor harness invocation.

Separately, launcher teardown again retained the existing macOS process-group
inspection `EPERM` race and exited 1. Its diagnostic observed the owned client
leader as a zombie before its close event; this is not permission to waive the
failure or signal a newly discovered PID. Final checks found no listeners on the
four owned ports or leftover owned database container. Unrelated Docker services
were preserved. The inherited 19 cow/dagger content errors also remain.

Root viewed actual hub, bank, wide and campus-link PNGs. The western dry shoulder
is now visible, but the island is still sparse and artificial overall. Large
floating house glyphs are a separate real scene issue: ZoneVisualsSystem renders
8m safe-zone sprites at terrain+15m for Central Haven and the pond. These are not
building substitutes or evidence of a bad building shader; this viewport reports
`towns:false` and its admitted building manifest has an empty towns list. Correct
their presentation independently, retaining all zone safety/gameplay rules.

Judge connected regions at the wide camera, readable rock/shoulder at campus-link,
natural boundaries, consistent grass roots, and preserved path/pond materials.
Reject painted bands, over-yellow albedo, clipping, shimmer, extra GPU errors or
unexpected geometry/population changes. Geometry remains the exact probe40 budget.
Matched frame-tail/GPU/thermal and decoded-stream qualification remain separate
open gates. Inherited cow/dagger content failures are not waived.

## Probe44 completed result

Actual headful Chrome/Metal WebGPU uses the same explicit 720p/DPR1/MSAA4 shadow
profile and unchanged runtime/build. The spatial study passes: 67 observations
and their final aggregate gates, 419/419 source pins, 350/350 archives and 39/39
expected PNGs verify. Standalone spatial/presentation JSON match report closures.
All eleven native HUD leases hide 178/178 descendants, then restore exact original
DOM state with no differences. Hide settling takes 212–250.7ms, restoration
18.4–130.5ms and their cumulative time 233.9–360.6ms, within the shared 450ms cap.
All owned style nodes and remote handles are released. No transitions are disabled.

All 67 actual terrain observations retain exactly 40 base-16, ten macro-64 and
two pond-128 leaves. The macro budget remains 84,420 triangles / 3,450,160 bytes;
pond detail remains 66,548 triangles / 2,690,928 bytes. CPU grass/surface checks
have no violation or missing hit across 767 repeated sampled bases; maximum
installed gap is 9.04474e-7m. Projection from worker terrain can move a base by
0.174488m; that distinct input-to-rendered-surface correction is retained. These
checks do not prove every blade, GPU contact, visual quality or animation quality.

The adapter is non-fallback Metal3, with one observed device and no uncaptured
device error, loss, GPU error or page error. Whole run remains **FAIL** for the
same 19 console errors: 14 canonical dagger fit-metadata and five cow-model errors.
The 36 HTTP receipts differ from the earlier 37 only by one fewer empty readiness
poll; both seed operations and all 14 equip / 14 unequip operations succeed with
HTTP200. Launcher exits zero, browser closes, all four owned ports are free and
cleanup errors are empty. Lightweight tracing is not native-lifetime proof.

Timing does not qualify smoothness: cold startup's RAF maximum is 1,392.1ms
(p95 76ms / p99 175.1ms). Post-equip positive render-counter intervals have
p95 33.4ms / p99 41.7ms / max 50ms; post-study p95 17.4ms / p99 24.5ms /
max 33.3ms. Those windows differ in moving camera and daylight/exposure, so they
are not a controlled performance comparison, GPU durations or presented FPS.
All six applied-profile observations retain 1280×720, DPR1, MSAA4, shadows and
no composer. No lower resolution or hidden quality change explains the result.

Report SHA256:
`5cf6e99f5cab094946d00a382f73ebc23ffecd97a487aa825dcc34f1b75bac98`.
Spatial study:
`dec430986261a9404d6128d5b8ca43c2b094feb4e9ccdaa281f269c1261e1c2c`.
Presentation:
`8d801ad33fb7671c6ffefd6c5718f62f5f5027f5a46f746d2d1645d0111445eb`.

Root directly reviewed wide, campus-link and bank PNGs. The connected dry western
shoulder reads, path/pond materials remain consistent, and no new seam is apparent
in these sampled views. Overall art still fails the target: visibly repetitive
ground, almost absent grass, empty shoreline, sparse canopy, coarse tree shadows,
flat character/material response and oversized floating house markers. This is
a verified material checkpoint, not an AAA-quality or production sign-off.

Next, actual server-class reproduction identifies only eight of 13 potential
resource trees at startup. Loaded terrain-only ring tiles never promote when
they enter the content radius; tile-center calculations also disagree with the
centered resource ownership convention. Fix that lifecycle before arbitrarily
adding canopy. Independently qualify camera-aware grass and compact-material
eligibility: current broadcast geometry contains only twelve grass clumps,
48 blades / 48 triangles, and the old biome threshold rejects some visibly
grassy preparation/pond ground. Both next changes need explicit population/cost
and authority tests; they are not included in this frozen material checkpoint.
