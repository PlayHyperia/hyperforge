# Compact smithy: verified functional checkpoint, unfinished art

Date: 2026-09-12. Branch: `codex/sol-duel-stream-launch`.
This is not AAA, performance, competitive, streaming or launch approval.
Earlier v1 assets manifest checkpoint: `1cc1550` on
`codex/duel-arena-launch-assets` (only the eight-line court descriptor).

## Open-truss v2: lighter silhouette, not finished scene art

Paired assets commit: `d9d0c66bfa95e1c72db70c1b8c236e737f52b039` on
`codex/duel-arena-launch-assets`; use this v2 manifest with the current game code.

The current `open-timber-smithy-v2` recipe replaces the large solid gable with
a 24-degree pitched roof, three exposed king-post trusses and two longitudinal
purlins. Posts, short braces, feet and the four blocked navigation cells are
unchanged; hashes captured before editing protect their geometry. The general
roof generator still produces identical default enclosed 32-degree geometry,
including the lodge. Rendering and native PhysX consume the same new geometry.

Cost is now 1,184 triangles / 197,448 geometry bytes: timber 1,052, roof 20,
footings 112. This adds 360 triangles / 60,480 bytes, retaining three materials
and batches, no new textures/lights, and the existing upper cutaway. The explicit
v2 hard recipe cap is 1,500 triangles; raising this cap is a documented art-cost
decision, not proof of performance. The manifest and strict validator advance
together; stale v1 recipe input is rejected, not silently interpreted as v2.

All eight current world views were reviewed in both `truss-smithy-native01` and
`truss-smithy-native02`. Open framing improves the front silhouette and lowers
the side mass. The anvil camera still reveals all upper framing correctly;
ground-level views retain the complete roof. The surrounding painted-looking
turf, sparse planar grass, dark foliage, synthetic coastline/ridges and simple
building finish remain visibly below the target. This is local art acceptance,
not an AAA claim or acceptance of avatar animation/fitting visible in the scene.

Checks: 1,236 shared tests / 90 files, including the 18 focused court/cutaway
tests; eight separate roof-generator tests; procgen/shared/client/server builds,
affected typechecks and scoped lint/format. Current native preflight passes
13/13. A separate historical session50 test still exceeds its old 648-input
source-count cap; nine other tests in that command pass. That historical
failure is preserved and no admission threshold was relaxed.

Both native reports pin the same 679 actual source inputs and archive 600.
Each retains 16 PNGs; the eight art-view cameras match the previous curved-meadow
baseline with maximum daylight differences 0.000524 / 0.001403, under the
unchanged 0.01 limit. Rendering remains native nonfallback Chrome152/Metal WebGPU,
1280×720, DPR1, MSAA4, 4096px sun shadows and no postprocessing. Both focused
studies pass. Both overall reports fail the same 19 cow/dagger content errors.

The first run additionally retains a launcher shutdown EPERM while the owned
client group was observed in zombie state; its groups/ports were subsequently
empty and its browser closed. The identical-source repeat shuts down cleanly.
This confirms intermittency, not resolution. No page/GPU errors in either run.
Ten-second campus/meadow p95 CPU ticks are 11.3/9.5ms then 11.7/10.1ms, with GPU
pass sums 13.96/15.07ms then 14.29/16.12ms. These are not presented FPS, full GPU
wall time, a controlled speedup or sustained full-agent/encoded-stream acceptance.
All 11,652 grass clumps remain; maximum fitting slices 2.2ms / 4.4ms still exceed
the 2ms target.

External evidence: `compact-smithy-court01/truss01/verify.mjs`,
`native-evidence.json`, `gable01.json`, `court01.json`, `regression01.json` and
`build-static01.log`. Report SHA-256:

- First: `cb5437fbe4091e1db26c1e8559d0a9936ef3b6446baa9ca8f98a0b3272017c38`
- Repeat: `3f98e8fb0c03ac29b008b4b8ea8c37a9a915765d81ebb64fdf1fdf7d87e960b3`

Research follow-through: current Three r186 [GTAO](https://threejs.org/docs/pages/GTAONode.html)
supports contact occlusion, but sample count costs GPU work and temporal filtering
requires TRAA with possible ghosting. [SSGI](https://threejs.org/docs/pages/SSGINode.html)
can add indirect diffuse light, with per-pixel sample cost and temporal/denoise
requirements. These are separate candidates, not enabled here. First qualify
contact on the actual foliage, ground and equipment, then moving-camera history,
cutaway/transparent-water behavior, correct color composition and disposal.
The installed postprocessing path currently supplies grading/blur/outline, not
these effects; their presence in Three examples is not proof of game integration.

## Earlier follow-up: timber color aliasing corrected, art still unfinished

Native79 isolated the defect with six one-variable A/B/A triples at the exact
native78 meadow camera. Disabling timber shadow reception, disabling roof casting,
zero/negative depth bias and increased normal bias all retained the regular dots.
Only replacing the procedural timber color removed them; restoring its graph
restored the dots. All six natural-daylight brackets passed (maximum phase spread
0.0080208333, exposure spread 0.000037696). The 24 PNGs, 652 pins, 583 archives,
37 frozen game files and exact appearance/camera/owned-process cleanup were verified.
This was one-camera diagnosis, not another full scene or performance qualification.

The explicit `woodFiltering: "footprint-v1"` opt-in is used only by the smithy.
It integrates both seam edges and neighboring plank tint over a bounded two-row
footprint, fades unresolved longitudinal grain, and approaches a statistical mean
for large footprints. It is a box approximation, not exact anisotropic filtering.
It changes no original albedo colors, roughness, global shadow setting, geometry,
texture inventory, resource or physics/nav owner. Other wood materials keep their
old graph. Five new material tests exercise the actual Three expression graph,
dense sampling, float32 limits, resolved detail and opt-in admission. CPU graph
evaluation is not WGSL execution or GPU timing.

Native80 then repeated the full six-view study: 24 PNGs, all 18 natural-daylight/
camera pairs matched native64 and direct unfiltered native78 (maximum direct phase
delta 0.0059614420, unchanged 0.01 bound). Six actual main-camera timber pipelines
contain the footprint derivative and unresolved-color limit. Root verification
covers 654 source pins, 585 archives, 41 independent freeze hashes, image hashes,
36 cutaway boundaries, both 48-tree censuses, existing grounded grass and HDR fog.
All six views were visually reviewed. The gable now shows continuous plank lines
instead of regular dark dots. This is local defect acceptance, NOT final art:
timber still needs closer finish/motion review, while oversized platforms, isolated
bank props, empty lawn, simple ridge/shore silhouettes and water/sky composition
remain well below the intended quality.

Verification: 1,135 shared regression tests plus 12 material tests pass;
14 focused native/cutaway tests are a subset of the shared suite. Strict affected
test and shared/client/server type checks, procgen/shared/client/server builds,
lint and formatting pass. The first combined test command used the wrong working
directory and failed six manifest-dependent cases; rerunning from the actual shared
package passes all 14, without changing assertions. The shared package's stale
`build:client` entry has no index.html; the real client package production build
passes. Both command-context failures are retained rather than counted as passes.
The old shingle test's actual NodeBuilder stack API is now explicitly typed.

Both native79 and native80 have zero page/GPU/cleanup errors and fully closed owned
Chrome/launcher/ports. Both remain overall false for the same five cow-model and
fourteen dagger-fit errors. GPU cost, presented-frame pacing, motion/ghosting,
live preparation/combat/streaming and long-duration stability remain open.

Evidence: external `compact-smithy-court01/verify79-root.mjs`,
`verify80-root.mjs`, `after80-root-verification.json`,
`wood-material-tests02.json`, `wood-native-tests02.json`,
`wood-shared-tests03.json`. Reports:

- Native79 SHA-256: `275d834a2908fd0f583d1ac5df970fffcb01a097a7fe733aa0ece626c00ca744`
- Native80 SHA-256: `b8030f5a5ad7dce20873b4136c0837c82d55edccf58d8d29819c43a82e8ef075`

Research: [WGSL screen derivatives](https://gpuweb.github.io/gpuweb/wgsl/#derivative-builtin-functions)
support estimating a fragment footprint; [Three shadow parameters](https://threejs.org/docs/pages/LightShadow.html)
have distortion/cost tradeoffs and were not changed by this fix.
[GTAO](https://threejs.org/docs/pages/GTAONode.html) and
[temporal antialiasing](https://threejs.org/docs/pages/TRAANode.html) remain candidates
requiring actual motion, lifecycle and GPU-budget tests, not default quality claims.

## Earlier grounded/cutaway checkpoint

The optional strict `compactServiceCourt` manifest descriptor owns one 10×6 m
open smithy at (336.5, 337.5). The terrain owner samples 37 actual heights after
terrain startup. Four independently grounded plinths occupy cells (331,335),
(341,335), (331,340), (341,340); no floor or walkable roof is registered.
The first 8 m proposal was rejected because its posts obstructed the apron and
a tanner approach. The original external PLAN.md remains historical.

The recipe has three private batches/materials, 824 triangles and 136,968 geometry
bytes. Its chamfered timber, braces, ridge and rafters use no new image textures.
The server/client physics owner uses the same generated triangles; a separately
owned static navigation lease preserves independent base/network collision flags
and overlapping owners. Retirement is idempotent; pending startup work is guarded.

The camera cutaway reads prepared world matrices without moving the camera.
A focus ray through the upper structure starts a bounded 220 ms transition;
a four-by-four screen mask has solid endpoints, without transparent sorting.
Upper-structure labels add 8,304 bytes, no triangles. At full cutaway, pointer
rays ignore only that upper structure; posts, native colliders and navigation
remain. An independent always-true shadow mask preserves roof shadow casting.
The main-frame callback ignores shadow/other cameras and caches stationary-camera
decisions. The current lower horizontal beams remain visible and can still
obscure a small workstation: art/motion acceptance stays open.

## Verification and rejected iterations

- 1,135 tests / 83 files in `shared-tests07.json`; 14 focused actual geometry,
  native physics, path and cutaway tests in `cutaway-tests01.json`.
- All 48 authored resource trees, all currently free cardinal service/resource
  approaches and all three authoritative duel-return marks use real BFS checks.
  Exact LOD0 selected-model crowns, station bounds, NPC clearances and path-mask
  support are checked. This is not every-LOD/wind clearance or live agent proof.
- Native/render triangle agreement checks all 824 triangles across three actual
  PhysX lifetimes. No mock renderer or mocked physics establishes this result.
- Strict affected-test and production shared/client/server type checks; procgen,
  shared/client and final server builds; 20-file lint/format checks pass.
- Twenty-seven capture controls retain the prior cameras, resolution, error,
  natural-daylight, fog and cleanup gates.
- Native76 completed technically but was rejected visually: roof hid the forge
  and agents, timber grain crossed the posts, shingles were oversized.
- Native77 stopped before scenic comparison because its diagnostic read the TSL
  boolean wrapper as a scalar. Native rendering had no page/GPU errors, but the
  required 24-image completion check correctly failed. Its report and 579 source
  archives remain immutable; the checker was corrected to read the actual
  ConstNode child, not weaken the expected true shadow mask.
- Native78 completed all 24 PNGs at 1280×720, DPR1, on real nonfallback WebGPU.
  648 source hashes, 579 archives, all image hashes/dimensions, 37 independent
  game freeze hashes and owned cleanup were checked. Thirty-six image boundaries
  show cutaway=1 only at anvil and zero in all other views; real compiled main
  shaders contain the fade uniform and discard. No GPU timing inference.
- All 18 camera/daylight pairs match native64 and the actual pre-fix native76
  at the unchanged 0.01 phase / 0.005 exposure thresholds. Max native76 phase
  delta: 0.0039180773. A supplemental older native75 comparison FAILS at one bay
  image (0.0106882594); it is retained as a failure, not promoted.
- Both actual 48-tree censuses, grounded grass, HDR fog and atmosphere checks
  remain intact. No browser page, GPU or cleanup errors. Owned Chrome and all
  four test ports close. Overall native78 remains false: five cow-model errors
  and fourteen `bronze_dagger: missing_fit_metadata` errors remain.

The root reviewed all six scenic views. The forge/nearby agents are now visible
from the unchanged anvil camera, and the roof is restored in overview. This is
a local visibility correction, not approval of the smithy's finished appearance.

## Next quality work, in order

1. Diagnose gable/timber speckling with a controlled shadow/material A/B. Do not
   assume every dark dot is UV noise; the current sunlight uses a 400 m shadow
   span / 4096 map, bias 0.0002 and normal bias 0.01. Preserve contact and shadow
   geometry; hiding all shadows is not a fix. Review cutaway during actual
   camera movement and agent preparation, including lower-beam occlusion.
2. Redesign the central composition as a connected place. Current 40×25 m lobby
   and 28×23 m recovery slabs dominate the single 20×24 m arena. The bank chest
   remains isolated from the lodge, and the surrounding lawn is undifferentiated.
   Any layout changes must update authoritative ground/return/navigation owners,
   not conceal geometry mismatch with a prettier camera.
3. Layer coherent ground/rock/shore materials and planting around actual
   choppable trees. No separate decorative tree population. The proposed bounded
   24-shrub court planting has not been installed.
4. Evaluate contact shading and temporal stability with actual WebGPU budgets.
   The existing unrelated CompactContactAO prototype is not integrated here.
   Add no effects/defaults on the strength of stills or CPU test counts alone.

Research supports the implementation direction, not a performance guarantee:
[Three NodeMaterial masks](https://threejs.org/docs/pages/NodeMaterial.html),
[WebGPU render pipeline](https://threejs.org/docs/pages/RenderPipeline.html),
[linear color workflow](https://threejs.org/manual/en/color-management.html),
[GTAO quality/cost controls](https://threejs.org/docs/pages/GTAONode.html).
Our installed Three revision is already 186; no dependency upgrade was needed.

## Evidence locations and identities

External evidence root: `asset-studio/compact-smithy-court01/`.
Final capture: `asset-studio/game-test-integration/compact-world-probe78/`.
Reports remain external rather than adding ~97 MB diagnostics to the game repo.

- Native78 report SHA-256:
  `25272efd4d1878521f966497e9cf33c947ae4a47c3e843785d710b46d9946f7f`
- Native76 rejected report SHA-256:
  `38f4d35f013b96928ce3be04972796da2a4affb4d67e786dc4c18b5603cdd41e`
- Native77 diagnostic-failure report SHA-256:
  `518f460dd25f76fbddfad0cb15168e212d4bcf2ae5dc8b59ff7e8dece977cf0d`
- Current world-config SHA-256:
  `2067016a0b3cf128b3ee9dc85829a5025a22661034b472f89121e16d5c59d6ab`
- Current full world content identity:
  `c2181cca610b391ff930c52e16b1eb1444fcf2b812847f8cb8ea0a1e09c18a88`
