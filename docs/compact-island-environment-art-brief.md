# Compact island environment art: next delivery slice

## Grass reference correction — next art priority, 2026-09-13

Current prerequisite: grade-native02 exposed a real sampling inconsistency,
not an accepted color result. Once the actual terrain noise texture is created,
CPU grass sampling switches from analytic noise to quantized bilinear texels;
the emitted worker does not. The reproduced off-center cell is 218/218 clumps
before initialization but CPU223/worker218 afterward. The correction must share
one deterministic sampler, preserve existing GPU texture bytes, and explicitly
requalify changed worker placement. Do not replace the observer with a matching
approximation or waive actual color/placement parity. The saved failing run and
new regression are evidence of the defect, not a visual upgrade.

The shared sampler correction now passes 416/416 checks across 26 files in a
serial run, all three package typechecks/builds and scoped lint/format. Old
analytic worker counts/hashes remain as historical data beside strict corrected
oracles and stronger byte-exact CPU/worker comparisons. A concurrent 415/416 run
hit the existing 250ms grounding guard; preserve that failure and retain the
limit. Native load/performance is not approved by the serial source pass.

Reference comparison against native07's restored .20 material still identifies
upright, separated ribbons and exposed granular turf as the principal shape
gap. After sampling/color qualification, trial upper-leaf arc .30 to .45 at
unchanged height, width and blade count, then judge actual overlap, access and
swept grounding. This is a proposed experiment, not implemented or approved.

The .12→.36 height-dependent normal trial is **rejected as a visual upgrade**.
Native02 captures matched meadow/anvil views and both naturally daylit clips;
root and independent review still find flat olive ribbons over exposed granular
turf, without a convincing gain in canopy depth. Restore the exact simpler .20
material while retaining expanded normal/geometry tests. No geometry, density,
palette, wind or global lighting change belongs to this rejected trial.

The explicit focused study completes shader/root/binding, terrain/tree, cost,
wind and full revisited-LOD checks. Overall native02 remains failed because a
periodically published cumulative grounding timer trails its live read by 7.6ms;
that reporting assertion needs a bounded correction, not another blind rerun.
The two views and clips are not the omitted full equipment/architecture scope.
All failed archives remain intact; no art/performance/default promotion follows.

Next color trial: compare a grass-only linear grade shared by the actual terrain
grass layer and CPU blade-color sampling before soil/path/rock blending. Current
scan mean [.12687,.16117,.03426] is deliberately more olive than legacy forest
[.12597,.23302,.04696]; current green is 30.8% lower. This is not a demonstrated
gamma fault, and the old reference's exact configuration remains unknown.
Preserve raw scan provenance; explicit artistic grading must test CPU/GPU parity,
texel clipping, exclusions and actual views. The [.95,1.30,1.10] versioned
`fine-meadow-green-v1` candidate is now implemented in the existing explicit
fine-meadow pair, not a new query or default. Startup selection is cached across
async loading; terrain, CPU fallback and emitted worker share it and reject stale
result echoes. Material checks pass 38/38, focused propagation 7/7 and integrated
checks 407/407 across 25 files, including a corrected projected-anchor index
proof and an early water/exclusion rejection control. Shared/server/client typechecks/builds and scoped
lint/format pass. Fresh native visual/performance qualification remains pending.
Keep root/tip shading fixed initially.
Color cannot fill coverage gaps; continuous canopy and smooth LOD remain open.

AMD's [procedural grass reference](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/)
separately addresses root darkening, normal softening and coverage compensation
through LOD. Those are useful design references, not native browser performance
evidence or permission to replace our grounded terrain with its planar patch.

Implementation has begun for an explicit fine-meadow profile: 25m grass-owned
cells borrowing real terrain, .7m spacing, slender .38–.86m independent stems,
and a 40m near-detail trial. Preserve the original native reference and all
authoritative exclusions. Corresponding blade roots/tips are progressive across
tiers, but full moving transitions, coverage and rendering cost are unqualified.
See `asset-studio/fine-meadow01/QUALIFICATION.md` for tests and remaining gates.

The first native fine capture exposed a camera-order bug before matched imagery:
grass detail followed the earlier gameplay camera rather than the final primary
render camera. The correction now uses the existing render-preparation boundary,
with cached pose/frustum and one bounded update; native03 verifies this and the
subsequent stale-LOD-intent correction. Final source passes 361/361 tests across
24 files plus shared/server/client types and builds. Native03 next stops at an
incorrect capture expectation for Three's small-cell uniform-matrix layout;
native04 verifies the corrected exact device/shader contract. Eight actual images
still show too much gray exposed turf, so increase individual leaf overlap and
soften root/normal shading without adding blades or changing global lighting.
Native04 also exceeds the natural daylight window on its eighth camera; re-admit
natural daylight per camera without widening the capture phase assertions.
Acceptance requires continuous eligible meadow volume, slender tapered blades,
no visible cell grid/detail ring, flush roots at slopes/rocks/trunks, and cohesive
green without a dark cyan blanket or fluorescent tips. Wind, temporal shimmer,
LOD transitions and sustained performance require motion evidence.

Native05 captures all eleven views: revised leaf area and shading improve local
overlap/curvature/green, but root and independent review still reject full visual
acceptance. Next target is coherent foliage/ground light response at fixed
population, not another height/density increase. Measured GPU-pass-sum p95 is
28.64/28.25ms (campus/meadow), worse than the sparse historical observation;
performance is not accepted and no presented-FPS claim follows. The run stops
before motion on a cached reflection-pipeline observer assumption. Native06
qualifies exact main/reflection bindings, then hits the habitat checkpoint's
16MiB serialization cap. Native07 verifies bounded lossless checkpoint transport
and saves both wind and moving-camera videos. Fixed-camera owner/source/root
invariance passes; the rail stops on a strict timestamp-uniqueness assumption.
The retained samples show 18→75→18m travel, LOD0→1→0 and no missing monitored
cell, but final revisited source/root/bounds collection was not reached. Both
videos are nighttime, so they do not qualify daytime softness, shimmer or subtle
LOD popping. Focused daylight native02 now supplies both clips and the missing
revisited source/root/bounds/draw proof; its final reporting failure is separate.
Keep native07's failure unchanged. Visual transition quality remains open.

The fixed-geometry height-dependent normal experiment is now tested and rejected;
keep the .20 constant, expanded regression coverage and captured comparison.
Indirect-only root occlusion remains a separate possible experiment, not a
proven normal bug, physical self-occlusion or a remedy for coverage holes.
The next explicitly disclosed color trial must preserve positions, draw passes,
textures, wind bounds and authoritative terrain/resource/service exclusions.

Native07 CPU p95 is 14.9/15.1ms and queried GPU-pass-sum p95 20.58/19.92ms for
campus/meadow; 55/58 actual main grass draws submit 2.10/2.65 million triangles.
Unchanged-source runs vary materially, so neither the faster observation nor
recorded-frame counts prove causal speedup or sustained/presented FPS. Rendering
headroom remains open without density or resolution cuts. The scoped source
checkpoint is committed/pushed as `8531b4cbf` under `dreaminglucid`; it remains
an explicit opt-in development candidate, not default or production promotion.

The user's earlier-game grass image supersedes provisional acceptance of the
current sparse tuft appearance. Saved reference and diagnosis:
`asset-studio/haven-architecture01/GRASS_RECOVERY.md`. Exact image provenance
is unknown. Root and independent review agree that fine overlapping blades and
continuous meadow volume are visibly stronger than the current isolated dark
rosettes. Retain those qualities at a lower height.

The earlier sparse island candidate used 1.75m clump spacing and twelve blades, while
ordinary near-grass uses .7m and twenty-four: 12.5× lower potential blade density
before eligibility/grounding/quotas, not a measured ratio to the screenshot.
Wider blades and three compact root patches cannot compensate for those gaps.
After architecture qualification, prioritize an explicit independently rooted,
slender, sufficiently overlapping meadow candidate before coastal work. Inspect
actual quotas and near/far LOD, preserve full-root grounding, access, wind and
quality settings, and measure added main/shadow/GPU/memory/loading work. No
still-image reference or passing implementation test proves visual acceptance,
motion quality or affordable density.

## Haven architecture checkpoint — 2026-09-13, art/performance still open

Native03 passes the local study after224 source/integration tests and37 capture
preflight tests. Independent verification matches722 source pins,644 archives,
24 checkpoints and44 fog brackets; all11 world PNGs and original9 cameras verify.
Source/render/actual-PhysX agreement and ownership are qualified for this slice,
not full traversal or production. Root and second visual review accept roof
scale/base/framing as a bounded improvement; dark timber, gray-blue plaster,
regular masonry and detached-looking lintels still need art work. Front detail
clips the apex; three-quarter shows the full roof. Grass is rejected above.

CPU p95 is18.0/18.8ms campus/meadow; summed GPU-pass p95 is19.398656/20.64384ms,
worse observed tails than habitat-native03, without isolated causality. Same
architecture draw counts, +1,016 triangles per main/sun pass; no free-cost or
sustained-FPS claim. All owned services/browser close, page/GPU/cleanup errors0;
19 existing cow/dagger errors still fail the overall capture. Report SHA256
`7a303d211260a61d600ff6c35592a7b55cb919b589a413ded03593f5b5406073`;
independent verification `asset-studio/haven-architecture01/native03-verification.json`
SHA256 `1ed9cc7da5aed8b804da9325478c5e2204a3cf205568e268e3565902ad81d756`.

The shared settlement kit is a completed local implementation slice. Reference image and full
built-in generation prompt: `asset-studio/haven-architecture01/CONCEPT.md`.
It establishes material/construction/landscape direction, not implemented pixels
or performance. Do not adopt incidental props, lighthouse or changed footprints.
Actual code inspection found color-only building surfaces and a 3.57× physical
roof-course mismatch. Explicit Haven recipes add restrained facade and roof
geometry plus bounded normal/roughness/occlusion response with common roof scale.
Keep current doors/windows/steps, station access, mesh/material owners and roof
cutaway/shadow semantics. Exact pre-finish identities remain comparison fixtures.

Primary research: [Three material nodes](https://threejs.org/docs/pages/MeshStandardNodeMaterial.html)
provide authored roughness response, and [surface-gradient bump mapping](https://jcgt.org/published/0009/03/04/paper.pdf)
provides a principled way to transform small surface slopes without changing
mesh geometry. These do not create silhouette, cast contact shadows or free
shader work. Geometry and surface response must be checked together under the
actual native WebGPU lighting, including oblique/moving views. Keep new normal
detail filtered at subpixel scale, preserve all existing main/shadow population,
and measure cost. Whole-landscape, lighting/contact and performance remain open.

## Shared habitat and avatar propagation qualification — 2026-09-13

Native03 now passes the local study after 325 tests across 20 files, three package
typechecks/builds and 30 capture preflight tests. Nine main views show only a
subtle local substrate transition, not a major art-quality improvement. The
whole setting still needs the high-impact work below. No appearance default,
AAA or sustained-performance approval is implied. Actual compiled shared-field
and grass ownership checks pass; 11,419 clumps / 411,084 installed grass triangles and
historical placement/grounding data remain exact. No extra textures or passes.

Failed native01/02 remain preserved: order-sensitive geometric work charges
must be reported separately across runs, and a redundant live own undefined
placeholder disappears in JSON. Narrow, tested observer corrections retain all
geometry/source-ID/output and same-run assertions. Native03 has zero page/GPU/
cleanup errors and closes owned browser/services; 19 existing content errors
still fail the overall report. CPU p95 is 17.9/14.8ms and GPU-pass-sum p95 is
18.81/19.07ms in the two short windows—not isolated savings or sustained 60fps.
The VP8 1280x720 wind clip decodes 232 frames and stops its recorder/tracks.
Report SHA256: `a842436948e9585ec865e7dfb190f6a7be710c567441062f0cc5b1be130038d0`.
See `asset-studio/habitat-propagation01/` for qualification evidence.

Independent final review matches all 717 source pins, 639 archives and 22
checkpoints. Root and a second reviewer accept a modest Haven substrate
refinement across nine image pairs, with no visible new hard seam/paint stripe.
Five avatar/shield pairs retain pose, color and placement; overlays prevent
full head/grip inspection. Three decoded wind frames show varying bends and
settled roots, not exhaustive motion acceptance. The opening encoded frame is
softer than later samples. Keep larger art, live physics, sustained frame and
streaming gates open. Verification JSON SHA256:
`fa64212bfb204b9e9e0b1a5ebfd90b2ccc8aab3e24eb71ec4c7b52971cb9f4b0`.

The current implementation adds an explicit `habitatComposition=haven-understory-v1`
trial on the existing natural-meadow route. Two authored, bounded convex pockets
connect the admitted foot-slope, functional tree bases and workshop rocks. The
same immutable half-plane field feeds complete terrain albedo/normal/roughness/AO
blending and the roots of existing grass. This is mineral-soil composition, not
new leaf litter. Grass tips, positions, grounding, all worker arrays, source IDs,
counts, bounds and shadow/resolution settings remain unchanged. It adds one
float varying to grass and no texture, geometry attribute or render pass. The
blade root uses the soil palette mean, not a claim of pixel-identical textured
terrain matching. Optional growth shortening is deliberately not implemented.

Real CPU/TSL and six-leaf worker regressions and native03's local study pass.
The verified native checks include actual terrain plus
six grass material owners, shared canonical field identity, compiled shader
evidence, exact historical signed-zero placement comparison and matched images.
No new appearance default is promoted by this local checkpoint.

The production avatar factory now propagates disjoint skeleton roots once,
preserving animation/recoil/humanoid order and existing movement behavior. The
authored 52-bone rig measures 457 to 61 recursive hierarchy visits per pass;
actual factory, seven animation clips and real VRM humanoid tests preserve bone
matrices, palettes, sampled deformation and attachments. This is reduced work,
not measured frame-rate gain. Native animated appearance/performance remains
open, as do the external CPU8 adapter allocation and equipment-LOD tasks.

Current upstream research reinforces measuring actual passes and bandwidth:
[Three's WebGPU post-processing guide](https://threejs.org/manual/en/webgpu-postprocessing.html)
documents combined passes and explicit MRT precision/packing, while
[Chrome's timestamp-query documentation](https://developer.chrome.com/blog/new-in-webgpu-121)
describes optional GPU pass timing and timer quantization. These capabilities
support controlled contact/lighting/temporal candidates; they do not establish
free performance or an AAA ceiling. Keep current native resolution, shadows,
population and matched reference views explicit in every comparison.

### Next high-impact delivery order

1. Finish the Haven workshop/bank → shoulder → pond-bank setting as a whole:
   stronger architectural bases/eaves, irregular stone boundaries, readable
   mineral faces and grounded shoreline transitions. Reuse the actual rock
   library and shared kit ownership, and improve silhouettes visible from the
   existing campus/Haven/pond cameras. Soil pockets cannot substitute for this.
   Preserve harvesting, stations, fishing and navigation; report every added
   main/shadow submission and memory cost. [Instancing](https://threejs.org/docs/pages/InstancedMesh.html)
   reduces submissions, not geometry/shadow cost.
2. Establish deformation-safe equipment LOD and measured frame headroom before
   accepting new fullscreen work. Current two-actor torso/leg kits alone submit
   about 1.145M triangles across main and sun. Retain close-up hero geometry,
   all required attachments and exact approved rest/weight ownership.
3. Qualify source-aware thin-leaf transmission independently of bark. The
   compact PBR branch currently bypasses the legacy backscatter term; a bounded
   [MeshSSSNodeMaterial](https://threejs.org/docs/pages/MeshSSSNodeMaterial.html)
   direct-light candidate may improve backlit leaf volume without adding ambient
   fill or globally recoloring authored teal trees. Retain alpha masks, wind,
   shadows and source identity. Reject glowing night crowns or washed-out bark.
4. Trial native contact occlusion separately, through
   [GTAO and builtinAOContext](https://threejs.org/docs/pages/GTAONode.html), not
   a dark overlay or the existing generic preference (which includes depth
   blur). Proposed initial comparison: 16 samples, 0.5/0.9m radii, unchanged
   native pixels and 4x MSAA. The depth/normal prepass, AO and possible denoise
   have real cost. Check animated/discarded vegetation, thin-surface halos,
   water/sky edges and moving cameras. Existing calibrated day-cycled PMREM
   already supplies environment lighting; do not double-fill it with ambient.

SSGI/TRAA remain later, explicit pipeline experiments. TRAA replaces MSAA and
requires correct velocity/history for animated foliage, avatars and camera cuts;
it is not a free quality toggle. A small habitat improvement does not close any
of these broader art or sustained-performance gates.

## Natural tuft trial and rendering research — 2026-09-13

The explicit `grassAppearance=natural-tuft-v1` trial uses the existing dense
meadow profile and 12-blade/36-triangle visible clump. Native01's broad paper-fan
silhouette was rejected. The revised three four-blade tufts use narrower
quadratic ribbons and an asymmetric shared height/lean hierarchy. Ordinary,
fixed-arena and previous meadow appearances remain unchanged.
Candidate wind uses world-space clump positions; smooth normals follow wind and
distance flattening without a new attribute, texture or pass. This is not exact
normal reconstruction of the later left/right root-height warp.

The native03 source passes 230 tests across 12 files, three package
typechecks/builds and 25 native preflight checks. The actual six-leaf
terrain/worker/grounding test preserves input arrays and all five installed
attributes for common survivors. A changed blade footprint can change accepted
populations without changing density settings; the first broad trial's CPU
census is not the final native census.

Native03 retains 11,419 clumps / 411,084 installed grass triangles across four
exact snapshots and six actual shader/grounding-buffer owners. That is 94 more
clumps than historical native05's 11,325 (+0.830%), not unchanged total work.
All 712 source pins, 634 archives and 18 incremental checkpoint hashes verify.
The eight-second 1280x720 VP8 recording completes, decodes 234 frames, and stops
its owned track/recorder. Root and independent review provisionally accept the
revised tuft silhouette, not whole-landscape or continuous-motion quality.

The full native03 study remains FAILED: an existing mushroom placement guard
rejects upload-counter advances after the grass/video gates. All 64 placement
buffers across 16 owners have identical full-buffer hashes/layouts with version
+1; production finalization unconditionally marks populated chunks for upload,
which is a plausible source-backed explanation, not a recorded call trace.
One separately qualified hero index widening also occurs. Do not ignore these
counters, claim JS-buffer identity across snapshots, or call the full run clean.
Downstream mushroom/outcrop images are missing; screenshot completeness fails.
Owned browser/launcher/services close and four ports clear. Zero page/WebGPU
errors coexist with 19 existing content errors. Native01 (exit137, cause unknown)
and native02 (now-fixed capture metadata collision) also remain failed records.

Native03's raw instrumented timings independently recompute: campus CPU
p50/p95/p99 = 15.2/32.3/44.7 ms (519 measured frames; max104.3 ms), meadow =
12.8/18.4/23.7 ms (592 frames). GPU render-pass sums are respectively
16.32/19.53/21.04 and 16.25/20.97/23.59 ms. These are not presented FPS or causal
grass costs. Campus CPU tails remain a real qualification concern. Actual
WebGPU 1280x720, 4x MSAA, existing shadows and no post-processing were retained;
no sustained-performance or default-promotion approval is implied.

Evidence: `asset-studio/game-test-integration/grass-natural-tuft-native03/`.
Report SHA-256: `131fa33934f55424caa7236b7e71cf1fc3832bf822f0120d25109d5ad9503e15`.
Video SHA-256: `f93b4c092dd9097343b78c78e4b50a383a4f49ff6ac44b9464ebe51c9eb9c1e6`.

Final review subsequently catches a fragment-stage edge case: opposing valid
vertex normals can interpolate to zero at full distance fade. Guarding that
interpolated normal and testing actual fragment inputs brings the final suite
to **231/231 across 12 files**; three package typechecks/builds and 25 native
preflight checks pass. Native04's local study and complete screenshot/cleanup
checks pass, with six native grass pipelines, four stable 11,419-clump snapshots,
nine world views and the completed wind clip. Overall remains failed on the
same 19 content errors, not on shader or cleanup failures. All 712 source pins
stay unchanged; owned browser/launcher/services close and four ports clear.

Native04 CPU p50/p95/p99 is 15.7/22.6/34.5ms campus (558 frames) and
14.2/19.6/24.0ms meadow (584); GPU render-pass sums are 16.25/19.92/21.50 and
16.25/19.99/21.10ms. This does not establish a causal improvement over native03
or sustained 60fps. The final 8,015.9ms clip is VP8 1280x720, 6,156,061 bytes,
228 decoded frames, with recorder/tracks stopped. Final report SHA-256:
`8dbf8e588772641bbd5c2bfd954cb870d6b2aef94cf28716702311dd95e2eabd`;
video `40e1c92306860efc38e993af5857277a523c1f064f83846d840975d186684a51`.
See `asset-studio/natural-tuft01/QUALIFICATION.md` for final versus historical
test hashes, the explicit counter-admission correction and retained failures.

The saved native03 CPU profile also identifies a no-quality-reduction
optimization hypothesis: `createVRMFactory` recursively updates descendants for
each skeleton bone, and movement forces another full hierarchy update. Qualify
one correctly ordered propagation from minimal roots against exact bone/skinned
position/normal/attachment behavior, animation and camera modes, with measured
traversal counts. The external CPU8 torso fixture separately allocates matrix
clones and transient per-vertex arrays during real deformation; pool these only
with identical arithmetic and safety guards. It is not a Chrome probe wrapper
or evidence of shipped-equipment performance. The profile has an initial1.193s
gap and late10-80ms sample gaps, so neither aggregate sampled weights nor GC
samples prove a cause for individual slow frames. Keep actual native measurement
and provenance, rather than declaring a speedup from source inspection.

### Next visible slice: connected habitat, not another blade adjustment

The terrain still reads as uniform turf with separate rocks and scattered
plants. Connect the admitted Haven foot-slope, western preparation trees at
(318.5,312.5)/(318.5,344.5), and workshop rocks into one coherent ecological
transition, first bounded to approximately x300-332/z303-365. Use asymmetric,
soft-edged pockets rather than circular tree rings or another talus stripe.
The existing grass/dirt/rock layers support mineral-soil transitions, not an
invented leaf-litter material. Share the composition across whole-PBR terrain
and vegetation, preserve functional tree positions and harvest/service access,
and measure any new cost. Historical resource IDs are not coordinates.

Current `havenGroundWeights` is color-only and `grassSupport` ignores Haven
wear/talus/planting, while the worker adds unrelated patch noise. That is the
implementation disconnect to address. Inline probability changes would also
re-phase the legacy RNG: genuine fixed-budget redistribution requires an
explicit bounded alternative pool, baseline quota and quota admission AFTER
full root grounding. Fail an unfillable candidate instead of silently thinning.
Require CPU/worker/TSL parity, actual installed counts/contact/routes, matched
close and aerial views, a moving path and measured native costs before approval.

The first implementation slice can avoid redistribution entirely: evaluate two
bounded habitat pockets in the terrain whole-PBR blend and at each existing
grass clump's world-space base. Blend the blade root toward the matching soil
mean while retaining its tip colour; optionally author local vertical growth
in [0.85,1]. Multiply the current distance fade by that factor in BOTH position
and smooth-normal graphs, never change uniform instance scale or post-grounded
world Y. The existing full-root validator sweeps fade 0 and 1, so intermediate
vertical factors remain inside its admitted envelope. Prove all five instance
arrays, source IDs, roots, counts and bounds unchanged. This creates coherent
substrate/shorter growth, not increased density or genuine leaf litter.

[AMD's procedural grass research](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/)
supports using curved ribbons and their derivatives to form readable grass
patches. We use those geometric principles within the existing instanced WebGPU
vertex path, not the article's different mesh-shader backend.
[NVIDIA's deformation chapter](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-42-deformers)
informs the normal correction; independent tangent calculations must verify the
actual shader graph rather than merely testing a second copy of its formula.

Three r186 already exposes local occlusion, screen-space indirect light and
temporal antialiasing. Those are subsequent controlled candidates, not free
quality switches: [SSGI](https://threejs.org/docs/pages/SSGINode.html) has explicit
per-pixel sampling and denoising costs; its temporal path warns about ghosting.
[TRAA](https://threejs.org/docs/pages/TRAANode.html) needs depth/velocity and
disables MSAA. Any experiment must declare that pipeline change, retain the
current native-resolution/MSAA comparison and test animated foliage, avatars,
camera cuts, contact and actual frame cost. Do not equate feature availability
with target-hardware performance or compensate through hidden quality cuts.

## Previous checkpoint: packed imports and mushroom LOD — 2026-09-13

The following plan is retained as history. The natural-tuft trial above now
implements the tuft and world-space wind work; the previous appearance remains
available unchanged, and broader landscape/performance gates remain open.

The packed-static import correction and same-owner mushroom LOD pass native05's
local study, not an AAA sign-off. The second native run exposed stale-camera
vegetation culling. The production correction now reconciles the final camera's
world transform, projection and depth convention without forced visibility or
changed draw distance. Final regression: 400/400 across 12 files, including 12
new actual quadtree/camera integration cases and 360 real sun rotations; three
package typechecks/builds and 30 native preflight checks pass. Native05 has five
close/transition captures and an identical-camera hero/LOD pair at 8.1m; both
reviewers accept local shape/color consistency. Independent checks verify all
710 pins/632 archives, actual main/sun draws and 25 rejected corruptions. Game
source `2f6f576ce05da4c2d1723ee1b40d349456446b1d` and assets
`a19894750710f2d8a7facdd98685011bf4c0ade5` are pushed under `dreaminglucid`.
Continuous temporal/contact quality and sustained performance remain open.

Do not infer a controlled speedup from previous mushroom totals: native02 and
the earlier Haven run submitted different instance/owner sets despite identical
recorded main camera poses. The earlier frozen view did not consistently govern
vegetation culling. Retain the failed receipts and establish a new final-camera
baseline. The 70.078% reduction describes one admitted model's triangle count,
not scene-wide frame time.

The next substantial visual change is **ground-cover cohesion**, not a denser
population or another broad exposure adjustment. Current `compact-meadow-v2`
already has curved geometry; its visible tier uses 12 blades/36 triangles per
clump, a 0.7m footprint radius and 1.75m center spacing. Reauthor that same budget
into tighter natural tufts with broader, shorter silhouettes and better root,
ground and blade-normal continuity. Keep existing instance counts, opaque
material, shadows, functional resource trees and the full rooting envelope.
Test changes as an explicit profile before accepting a new default.

Then address world-continuous wind: the current shader's phase uses chunk-local
offsets despite its world-space description. Equivalent world positions encoded
under different chunk origins must have identical phase. Preserve swept bounds,
anchored roots and displacement amplitude; verify changing normals and motion
in actual clips. Follow with shared mid-scale turf/blade reflectance variation,
restrained shrub color and deliberate coast/rock planting composition.

Acceptance requires low-angle, front/backlit and close moving-camera views,
complete grounding/worker/TSL parity checks, stable source and instance owners,
and actual workload/timing measurements. Static screenshots cannot establish
wind continuity, temporal stability or sustained frame rate. The current wide
views still look artificial; functional magic-tree colors are partly authored
and do not justify globally recoloring all trees or lighting.

## Ground refinement and useful frame headroom — 2026-09-13

The first Haven ground trial removes the arbitrary lawn color islands and
connects the workshop apron. Its broad gray talus band is visually rejected;
native02 retains a narrower slope-gated rock transition after two independent
nine-image reviews confirm the artificial band is gone. All1,330 regressions,
three package builds/typechecks and20 preflight tests pass;701 current source
pins/623 archives, unchanged terrain/grass hashes and48 resource trees are
independently verified. The19 existing content errors and sustained-performance
gate remain open. Do not present this local improvement as the finished landscape.

The latest source/receipt audit identifies a concrete scalability defect: small
mushrooms have 5,013 triangles each, no supplied LOD models, and category-level
LOD/impostor exclusions. They submit 270–391k triangles across main and sun in
the two recorded views. Complete torso/leg kits contribute about1.145M across
both passes for two actors. Trees are not the dominant geometry cost, and the
most visibly blue tree has intentionally teal/blue authored source maps.

Next performance work should retain close-up assets and actual populations,
but qualify geometry by projected visual error. Meshoptimizer documents
[attribute-aware simplification and screen-space error](https://github.com/zeux/meshoptimizer#simplification)
for preserving texture/normal quality and selecting suitable detail levels.
[Three LOD](https://threejs.org/docs/pages/LOD.html) provides distance switching
and hysteresis; our existing instanced vegetation owner should retain batching
and gain an explicitly admitted LOD path, not a separate per-instance object tree.
These mechanisms do not establish visual equivalence or savings by themselves.
Require close silhouettes, UV/normal response, threshold motion, zoom/camera
cuts, shadow continuity, loading/lifetime checks and actual pass/frame evidence.

## Shared Haven candidate implemented — 2026-09-13

The prototype below is now implemented in the shared profile/worker path and
selected in the local launch-branch manifest. Actual retained geometry rejected
the original 64-grid shape: 0.736m height discrepancy and 0.141m edge mismatch.
After forty bounded comparisons, the candidate uses wider drainage, an 8m face
and one local 64→128 leaf refinement: +24,832 triangles / 1,000,448 bytes, no new
terrain nodes/draws. Sampled discrepancy is 0.07574/0.07210m and the equal-grid
edge agrees to numerical roundoff. This supersedes the prototype's claim that
the unchanged mesh allocation suffices; native frame and visual gates remain.

Forty unit, four actual worker/mesh/road integration and two native PhysX/resource
tests pass. The latter cook test-owned colliders, not the live terrain owners.
Final regression is 1,324/1,324; shared/client/server typechecks/builds and lint
pass. Native01 includes a new eye-height Haven view plus eight exact comparison
cameras: 700 unchanged pins/622 archives, 37 fog brackets, 48 resource trees,
both actual 128-grid leaves and clean owned-session shutdown independently
verified. Overall run remains false with 19 existing dagger-fit/cow404 errors.
Short p95 CPU14/13ms and GPU-pass sums17.63/18.55ms are not presented FPS,
sustained60 or a causal cost comparison.

All nine images were visually reviewed. Local relief is improved, but arbitrary
yellow/green lawn patches, weak mineral/turf transitions, dark blue-green foliage,
inconsistent asset styles and the exposed coast still fail the art bar. The
next visual slice replaces noise-authored lawn islands with composed Haven
ground-cover, wear and talus using the current packed layers. No new full-screen
pass, light, resolution reduction or global quality downgrade is justified.

Source tracing additionally confirmed a terrain/camera PhysX query-mask bug and
an absent optional avatar foot-clamp implementation. Both now have explicit
launch tasks. See `haven-shoulder-terrain-20260913.md` and the mirrored checklist.
The native preparation broadcast has physics=false; these captures do not prove
averaged terrain boxes displaced the camera.

## Ready external terrain prototype — 2026-09-12

The bounded Haven west-shoulder prototype now uses one asymmetric ruled crest,
rock face, shelf and toe with an oblique drainage notch, not additional ellipse
hills or noise. Region X272–314/Z303–367; existing campus/arena grades retain
authority. 101,096 protected probes have exact zero delta; all48 archived native
tree heights reproduce, all11 paths/260 segments remain unchanged, and the same
two64/128 terrain leaves cover the change. The game has not adopted it yet.

Do not mistake this external analytical proof for a native surface. New slopes
exceed40 degrees at6,118/43,433 fine samples, versus363 before. Floor clamp and
nearest-polyline notch can make internal derivative creases; actual terrain mesh
spacing is1.5873/.7874m, not the .25m evaluation grid. Next: integrate into the
shared profile/worker path, retain protected surfaces, then check real triangle
contact, fresh tree/nav ownership and moving eye-level/aerial appearance before
acceptance. See `asset-studio/service-planting-soil01/terrain-next-slice.md` and
`haven-shoulder-evaluation02.json` for exact curves, source pins and remaining gates.

The preceding lossless shield pass confirms72 fewer actual submissions across
main/sun without detail loss. It does not supply approved headroom: native03 p95
CPU14.5/16.9ms and GPU-pass sums17.50/21.30ms remain outside smooth-performance
acceptance. No new postprocessing or resolution/quality reduction is justified.
Outer-face captures also expose existing sideways shield carry; keep that fit
gate open independently of successful geometry/material preservation.

## Next substantial slice: composed Haven landscape — 2026-09-12

The service-soil native pass is technically verified but **not art or performance
approved**. The reused dirt layer reads as gray gravel-like halos under the
shrubs; fern silhouettes are dark and the clumps remain overly saturated and
repetitive. Do not confuse this local contact improvement with a finished scene.
All eight current views and the concept were reviewed together. The dominant
remaining deficit is composition, enclosure and landform scale, not a missing
bloom or ambient-occlusion switch.

The concept establishes a low broken rocky backdrop behind the workshop and a
connected shore/soil/path hierarchy. Current buildings and trees sit in a broad
flat mottled lawn. `CompactIslandLandform.ts` fades the terrace delta out at world
X274–280, leaving roughly 47m before the western service beds. Smooth ridge and
saddle envelopes read as isolated capped hills. Increasing their noise amplitude
or applying another global color field will not solve that structure.

Author one connected Haven ridge-to-pond rocky-meadow slice: an unequal crest,
two readable rock faces, a lower shelf and irregular foothill/toe approaching the
workshop. Protect actual station, path, pond-fishing and tree-harvest envelopes,
not a broad arbitrary empty strip. Material allocation must follow these forms:
mineral faces, earthy hollows/toes, turf on the flatter shelves. Reuse the vetted
rocks for human-scale edges, not mountain-sized props. Existing choppable trees
must form the island's tree population; no disconnected decorative forest.

Resolve the silhouette and layered depth in unchanged ground-level and aerial
cameras before adding small details. Start within the existing local terrain
detail allocation, six-map budget, LODs and renderer/shadow settings. Maintain
server/worker/native agreement, supported assets and all functional approaches.
The exposed bay coastline remains a subsequent distinct slice. The large
playable island is not a preservation requirement; the user's compact-only
direction supersedes earlier historical preservation notes.

Frame headroom currently fails: short instrumented p95 CPU18.3/20ms and GPU-pass
sums28.38/33.88ms for campus/meadow. These are not presented FPS or an isolated
soil-cost experiment. Native-qualify the prepared lossless shield batching
candidate (23→5 primitives; identical geometry/materials/fit) before spending
more frame budget. Also retain the build-contended grounding failure as a stress
follow-up; the unchanged-budget standalone suite passes1,278/1,278.

Evidence: `../asset-studio/service-planting-soil01/README.md` and
`../asset-studio/shield-material-batching01/README.md` from this repository root.

## Material and lighting follow-through — 2026-09-12

The native landscape-rock review confirms a render/contact/LOD checkpoint,
not finished art. All eight views still show weak material integration, blue
shadowed foliage, a flat lawn and artificial coastal/ridge shapes. Do not
mistake more props or green software tests for closing this visual gap.

The installed renderer is already Three r186. Current official references:

- [Standard node materials](https://threejs.org/docs/pages/MeshStandardNodeMaterial.html)
  use the scene environment for PBR lighting. The importer had unconditionally
  erased authored metalness under an obsolete no-environment assumption.
  The import and persisted-cache policy are now corrected; eight native daylight
  views verify actual service-model factors/maps. Night, broad asset appearance
  and integrated art/performance acceptance remain open.
- [MeshSSSNodeMaterial](https://threejs.org/docs/pages/MeshSSSNodeMaterial.html)
  provides an experimental direct-light scattering term. Its installed source
  cites the author's [real-time translucency work](https://colinbarrebrisebois.com/2011/03/07/gdc-2011-approximating-translucency-for-a-fast-cheap-and-convincing-subsurface-scattering-look/).
  Evaluate thin foliage only after inspecting source normals/materials. This
  is not full volumetric scattering or permission for unshadowed emissive leaves.
- [GTAO](https://threejs.org/docs/pages/GTAONode.html) can add contact occlusion;
  [SSGI](https://threejs.org/docs/pages/SSGINode.html) can approximate local
  indirect light. Both cost samples; temporal filtering adds motion-history
  risks. SSGI's documented temporal path requires TRAA and warns about ghosting.
  Qualify animated foliage, agents, camera cuts, water and cutaway roofs before
  selecting either. Do not add them merely to darken an incoherent material mix.

Working decision: fix imported material fidelity and qualify foliage light
response first, with no changed exposure, resolution, terrain, trees, population,
camera or shadow budget. Then revisit contact/local indirect lighting and the
larger authored landforms. This is an implementation sequence, not a claim that
these features alone deliver the requested quality.

## Current priority after native review — 2026-09-12

Curved instanced grass is pushed as an explicit comparison-profile checkpoint,
not finished environmental art. The subsequent two-scale ground-colour candidate
passed technical checks but was rejected after eight native views: adding fine
mottling did not materially improve the scene. Its source changes are removed
and evidence retained in `compact-grass-grounding-integration01/field01/` under
the local asset studio. Do not repeat that generic colour-noise route.

Deliver the existing preparation-scene target as an integrated art slice:

1. Deliberately compose grounded rock and understory groups around pond banks,
   grove edges and the workshop approach. Use the existing scanned outcrop LOD
   library where suitable, but provide physical obstruction/navigation where
   visible rocks occupy playable space; the temporary six-rock diagnostic is
   not permanent world placement. Keep trees as actual choppable resources.
2. Replace the scattered-stations-on-a-lawn impression with worn interaction
   ground and a cohesive stone/timber architectural kit: bases, framing,
   eaves/ridge/end treatment and credible workshop detail. Preserve roof-cutaway
   camera behavior, fixed interaction access, authoritative collision and costs.
3. Review the pond → bank/workshop → arena route in motion, alongside close and
   broad stills. Require coherent silhouettes, scale, surface contact, foliage
   color and useful gameplay sightlines. Follow with sustained target-hardware
   and encoded-stream checks; existing short instrumented windows are not those
   acceptance gates. Large geology must use deliberate closed construction,
   not the rejected automatic open-facade closure approach.

The concept below remains a target, not a claim that the game looks like it.

User review, 2026-09-10: the current terrain is still lackluster and low quality.
This is accurate. Removing biome wedges and correcting sampled grass contact
did not turn the bare grass/dirt blockout into a finished game environment.

Current work and explicit source-test/cost limits are recorded in
`compact-pond-bank-checkpoint-20260910.md`. The material/path/local-detail
candidate is implemented; it is not yet an accepted finished environment.

## Visual target, not a game screenshot

The imagegen skill was used to establish a concrete environment-art reference
with the built-in image tool. The local project copy is
`../asset-studio/island-environment-art-v1/compact-preparation-target01.png`
relative to the game repository; the full prompt is in `TARGET01_PROMPT.md`
beside it. PNG SHA-256:
`53817adc8d258ccb6b21582a0a228b8a18ed57e1b184f55e997dee1599e70b50`.
These authoring files are local, not part of the game source push.

The reference demonstrates deliberate rock/bank silhouettes, a readable natural
pond, differentiated stone/earth/grass/wet margins, grouped vegetation and a
connected workshop-to-arena route. It is **concept art**, not implemented assets,
approved placement, measured performance, or a promise of identical rendering.
Its arena count, building placements, dense foliage and decorative items are
not authoritative game data. Preserve functional IDs and validate any relocation.

## Build one finished preparation scene first

The first real art slice is the existing pond → bank/workshop → arena approach,
not another generic noise or palette adjustment across the entire map.

- [ ] Author clear primary/secondary landforms: low rocky ridge and coherent
      coastal silhouette; believable local pond banks and shallow depth; usable
      paths, flat interaction areas and unobstructed combat-camera sightlines.
- [ ] Give the bank, furnace/anvil and cooking locations a shared architectural
      setting and worn ground. Use a small reusable stone/timber kit; avoid isolated
      stations sprinkled on a lawn. Keep authoritative interaction positions valid.
- [x] Integrate six packed soil/turf/rock maps with actual normal/roughness/AO,
      exact-byte preflight and decode controls. Follow-up adds anti-repeat grass/dirt
      projections and worn path edges; finished wet-bank transitions remain open.
- [ ] Compose bounded rock, shrub and grass clusters around banks/paths, with
      intentional open circulation. Preserve batching, shared materials and LODs;
      do not blindly turn on bulk procedural population or grass everywhere.
- [ ] Use the existing choppable resource trees as the island's tree population,
      naturally distributed around the compact one-arena layout. Preserve reachable
      resource targets, tier availability, collision, depletion/regrowth and agent
      preparation. Do not fill the landscape with a separate decorative forest.
- [x] Resolve ocean material ownership and visible square water transitions.
      Ocean appearance must not change simply because a chunk center crosses a mask.
- [x] Compare bounded denser pond geometry: two100m streaming leaves now use128
      vertices/axis; hub policy64, other streaming leaves16. Final irregular-pond
      RMS error0.02764650m, maximum0.17675727m over7,921sample points. The two actual
      leaves have66,548triangles/2,690,928geometry bytes, +49,664triangles/+2,000,896
      bytes versus64. These are explicit costs, not frame-time acceptance.
- [ ] Finish pond/coastal topology and all-footprint prop contact; the measured
      residual bank error and circular silhouette are not a finished terrain gate.
- [ ] Capture actual close, preparation-wide and arena-approach gameplay views in
      consistent daylight, then moving-camera and night views. Evaluate composition,
      scale, material response, contact, silhouette and UI/agent readability together.
- [ ] Measure representative loading, CPU/GPU frame distributions and memory with
      the real agents/assets/stream workload before accepting performance. An image
      reference or intrusive static diagnostic cannot satisfy this gate.

Acceptance is an actual recognizably finished scene, visibly beyond the current
blockout while retaining the working preparation/duel loop. Numerical correctness
and material startup tests remain safeguards, not the main art deliverable.
The full island, equipment, reliability and launch checklist remain open.

## Existing-kit starting point

Read-only local inventory identifies `rocks/med_rock_v2.glb` and
`rocks/big_rock_v2.glb` (778/910 triangles, one primitive each, embedded albedo/normal/ORM)
as a small starting boulder pair. Existing round/path stones, ferns, shrubs and
oak variants can supply selected clusters after visual/texture-budget review.
The local `terrain/textures/{stylized_grass,dirt_ground,rock}` folders contain
normal/roughness maps now used through the six losslessly packed terrain maps.

Do not enable the current generic vegetation path unchanged: it extracts only
the first mesh of an asset and its water-clearance policy excludes pond-bank
placements. Some low-triangle assets have large 2K textures; triangle counts alone
do not qualify them. An isolated Blender pond kit now contains boulder, flat
stone, fern, bush and original reeds. The promoted CC0 Fern02 brings the kit to
approximately21.9427MiB estimated texture/mip allocation and37,068submitted
main-pass triangles across32instances/five batches. Probe17 verifies improved
wet margins/root contact, not finished habitat or representative performance.
A reviewed workshop-canopy candidate still awaits collision, flue and camera
integration. Imported asset creator/license attribution remains unresolved; this
inventory is reuse research, not a distribution-rights or performance approval.
