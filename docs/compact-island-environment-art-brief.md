# Compact island environment art: next delivery slice

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
