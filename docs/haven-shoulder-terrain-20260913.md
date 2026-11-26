# Haven shoulder: shared terrain and retained-mesh qualification

This is a working visual candidate on the launch branch, not AAA, motion,
foot-contact, frame-time or production approval. It replaces no authoritative
duel/betting rules. The compact island and single arena remain the active world.

## Implemented surface

### Ground composition follow-through

The first ground-material trial (`haven-ground-native01`) removes the arbitrary
fresh/dry meadow tint and adds a connected workshop wear apron using the existing
six packed maps. Its native images improve those two aspects. Its broad talus
ribbon, however, reads as a paved gray road at the hill foot and is **rejected
visually**. A technically passing study does not make that treatment acceptable.
The retained failed-art capture is not a production reference.

The material field is detached/frozen and shared with the real emitted grass
worker; all four PBR channels use the same weights. It changes no heights,
terrain allocation, road mask, grass support/placement/RNG, tree population,
render resolution, lights or shadow settings. Removing the old meadow tint also
removes its extra noise lookup. Additional field arithmetic still has a real
shader cost; no frame-time saving is claimed.

For this first trial, 46 focused tests and the 95-file regression (1,330/1,330)
pass under Node 22.23.2. Shared/client/server typechecks and builds pass. The
current `service-planting01/study01.test.mjs` invocation is **19/19**, not 23;
older 23-test summaries do not describe this single-file invocation. Independent
native verification passes 701 current pins, 623 archives, nine exact cameras,
37 clean fog brackets and eight rejected corruption controls. Actual terrain
position/index digests, world identity and 48 authoritative tree owners remain
unchanged. New grass buffer digests prove current-run stability, not unavailable
historical byte equality.

Report: `haven-ground-native01/report.json`, SHA256
`0292434e80a1aef12838cde4dde392942f407c0f67f9ffe2db312a9010cd05c5`.
Verifier result: `native-verification-haven-ground-native01.json`, SHA256
`4ab8b402f4c26b7e412bf783852f38757a80ab662138f98cadfa78e249354832`.
Page/GPU/cleanup errors are zero; the owned browser and stack are closed. The
overall run remains false with 19 existing dagger-fit/cow404 content errors.
Short p95 CPU14.8/13.3ms and GPU-pass sums18.15/19.46ms (campus/meadow) are not
presented FPS, sustained60, full-load streaming or an isolated cost comparison.

The bounded refinement is now retained: core/outer radius .6/3.5m, strength .65,
rock fraction .85 and smoothstep(.008,.05) on geometric slope. Both reviewers
inspected all nine native02 images. The artificial band is gone, the meadow and
work apron remain, and no obvious new static material regression was found.
This closes the local refinement, not the overall environment-art gate.
The GPU uses the retained mesh geometric normal; the existing CPU grass palette
uses authored-height finite differences. Same-input gate algebra is tested,
but these slope sources need not coincide at every root. Inspect root-color
cohesion at the toe; do not equate arithmetic parity with pixel equality.

The final 46 focused tests, 95-file regression (1,330/1,330), all three package
typechecks/builds, lint/format and 20/20 capture preflight tests pass. Native02
independent verification passes all701 current source pins /623 archives,
nine matching cameras,37 clean fog brackets,13 corruption controls, unchanged
terrain geometry and grass offset/root hashes against native01,48 resource trees
and full world identity. Page/GPU/cleanup errors zero; browser, launcher and owned
ports closed. The overall run remains false with the same19 content errors.

Native02 report SHA256:
`c2045903b8fb01502a6633520ce64788b2334296f92e5718c5554ef8d3def600`.
`native-verification-haven-ground-native02.json` SHA256:
`f069fadcdabc8e9398c02fa3958c0573b135102bf6dac64ff1dc619c2a581eb8`.
`haven-ground-regression02.json` SHA256:
`82ae6b0419988562f5025f624bfd77917c717eabc4810a2df24e689e3ecccf60`.
`haven-ground-build02.log` SHA256:
`963d8947b1cbcbd290d1e6799c452e5eb4d8e4f7750fe1cd0f061bdad3ccd5fa`.

Final short instrumented p95 CPU16.5/13.8ms and GPU-pass sums18.284544/19.398656ms
(599 frames per campus/meadow window) remain unapproved performance evidence.
Different actor poses/workloads prevent isolated attribution. No sustained60,
presented-FPS or encoded-stream acceptance is implied.

Stop iterating this toe treatment. Remaining art gaps include carpet-like turf,
sparse isolated grass blades, overly dark/cyan tree presentation, saturated
shrubs, weak prop contact, conical grass-capped distant ridges and broad rounded
service/path patches. The exposed coast still needs substantial authored work.
The source-pinned `tree-lighting-mushroom-lod-audit01.md` distinguishes authored
magic-tree color from a normals defect and identifies a concrete next efficiency
task: admit visually qualified mushroom LODs into the existing instanced owner,
preserving close hero geometry, population and shadow continuity.

The preceding terrain/landscape checkpoint is committed and pushed to the game
branch as `0b75b5ab184d5b5efd142eeb8619687729411dc7` and assets branch as
`37e88245a411fc97118ff818453b3291b411f6ba`; GitHub author and committer were both
verified as `dreaminglucid`. This subsequent ground trial is separate work.

### Shared height field

`WorldTerrainProfile.havenShoulder` explicitly admits bounded world-space data
for an asymmetric crest, rock faces, meadow shelf, toe and oblique drainage in
X272–314/Z303–367. The base sculpt-v5 fixture remains numerically unchanged when
the modifier is omitted. Full profile/content identities include every field;
the existing profile-family ID is not treated as proof of identical content.

The same self-contained factory is embedded in real workers and used on the
main thread. Detached, deeply frozen data has bounded finite controls and
ordered/shared knots. Range-preserving PCHIP curves and global X-hull separation
avoid curve overshoot and zero-width branches. Compiled curves are weakly cached
by descriptor identity, not profile ID, without per-sample allocations.

The exterior collar preserves the previous height exactly. Authored campus,
station, arena and other grade overlays remain downstream and authoritative.
Coastal masking also applies to the modifier delta. Drainage uses the maximum
of continuous, individually end-faded segment fields; this fixes a possible
height discontinuity from choosing only the nearest segment. Internal derivative
creases remain possible at field intersections and the grade floor.

## A failed prototype became a better candidate

The first actual retained-mesh test failed: the existing 64-grid triangles
bridged the narrow drainage cut, producing a 0.736143m height discrepancy and a
0.141021m mismatch at the adjacent 128-grid edge. The smooth analytical prototype
did not establish that those meshes were adequate. Failed results are retained.

Forty bounded alternatives compared shape controls and actual geometry. The
selected wider drainage and 8m face run preserve the roughly 10.7m added relief.
Only the western Haven leaf changes from 64 to 128; the eastern leaf already had
128. Six existing preparation/arena/grove viewpoints retain their node-owner
sets. No extra terrain draw, material, texture, render pass or light is added.

| Measurement | Previous allocation | Selected candidate |
| --- | ---: | ---: |
| Western leaf triangles, including skirts | 8,442 | 33,274 |
| Western leaf geometry bytes | 345,016 | 1,345,464 |
| Sampled western analytic/triangle discrepancy | 0.11908m | 0.07574m |
| Sampled eastern analytic/triangle discrepancy | 0.00928m | 0.07210m |
| Sampled common-edge mismatch | 0.00936m | 1.42e-14m |

Exact increment: 24,832 triangles / 1,000,448 bytes. This allocation is not free
GPU time and is not presented-FPS or sustained-load approval. The 7.6cm maximum
is a sampled terrain-shape bound, not a character-foot tolerance.

## Verification and remaining gates

- Forty schema/corruption/immutable-cache/continuity/parity tests pass. An
  independent minified full worker also returned 256/256 exact CPU heights
  through its real request handler in an actual worker thread.
- Four integration tests preserve 69,551 protected probes and the actual
  256 road mask; emitted quad-worker buffers agree with CPU geometry. Exact
  retained triangle-plane/normal checks and refinement ownership pass.
- Two real PhysX/resource/navigation tests pass on the selected 128/128 leaves.
  They qualify test-owned cooked geometry and current route connectivity, not
  live terrain collider installation or animated avatar contact.
- Initial broad regression: 1,320/1,324. Four historical terrain fixtures
  inherited the new active profile; they now explicitly select their original
  baseline without relaxing counts, margins, masks or geometry expectations.
  Final rerun: **1,324/1,324 tests across 95 files**. All shared/client/server
  typechecks and builds, 44 changed-file lint/format checks and 23 native
  preflight tests pass.
- Final test-owned PhysX coverage: 2,364 ray comparisons through two lifecycles,
  maximum surface error below 4.6e-6m, exact releases and post-removal no-hit
  controls. Fresh navigation preserves 48 trees, 192 free approaches and 768
  complete routes per profile. The 78,166 baseline route edges still connect;
  sampled one-metre route grade peaks at 0.9661 (not slope-policy approval).

## Actual native review — completed, art gate still open

`haven-shoulder-native01/report.json` SHA256:
`4615d9efb44c3e57252cf82b87dc184ea06ce6dd7d4baf47a849a95685f39ad8`.
An independent verifier checks all 700 current pins / 622 archives, nine world
PNG hashes, eight exact baseline cameras, 37 screenshot fog brackets, 48 unchanged
resource trees, and both installed 128-grid leaves. Their actual material is
shared, each contains 33,274 triangles / 1,345,464 geometry bytes, and retained
surface identities match the full candidate. Buffer digests are source-bound
browser receipts; raw arrays were not archived for an independent offline
recomputation. Native road census is not recorded; the separate real CPU road
mask proof and unchanged manifest/source pins remain the available evidence.

Page/GPU/cleanup errors are zero; owned browser, launcher and ports are closed.
The terrain study passes. The overall run remains **false** with the same
14 canonical dagger-fit errors and five cow404-related errors; none were hidden.
The independent verifier also passes 14 negative controls. Its evidence SHA256:
`36c4dd085fa14641249edc945bb1eac2d73dd781edb928400afe30d5a18b246e`.

Short instrumented p95 CPU is 14/13ms and GPU-pass sum is 17.629184/18.546688ms
(campus/meadow). Previous shield-native03 was 14.5/16.9ms CPU and
17.498112/21.2992ms GPU-pass sum. Changing agent poses and measured workloads
prevent an isolated speedup/cost claim. These are not presented FPS, sustained60,
full streaming load or hardware-population qualification.

All nine views were reviewed, including the new eye-height Haven view. The
shoulder improves local relief, but the scene is **not AAA art approved**:
arbitrary green/yellow lawn patches, weak mineral/turf transitions, dark blue-green
foliage, disconnected prop/building styles and unfinished coast remain. Next
visual slice: authored ground-cover/wear/talus composition with the existing
packed layers, followed by foliage and coherent lighting/asset treatment.

The separate source-pinned contact audit found two pre-existing launch gaps:
terrain query-filter word1 admits unrelated camera masks, and the actual avatar
factory does not implement the optional foot-clamp API. Character height uses
gameplay support, not retained triangles. Correct query semantics and implement
a deliberately bounded presentation-support contract separately; preserve
server authority, deck/floor/stair/arena precedence and simulation filtering.
The native preparation broadcast explicitly has `physics=false`; it does not
demonstrate averaged-box obstruction. That query defect applies when an actual
physics owner is installed and needs its own instrumented camera reproduction.

External evidence directory:
`/Users/lucid/Documents/hyperia/asset-studio/service-planting-soil01/`.
See `haven-retained-parameter-search01.json`, `haven-regression01.json` (retained
failure), `haven-regression02.json` (final pass), `haven-build01.log`,
`native-verification-haven-shoulder-native01.json`, and `terrain-contact-audit01.md`.

Current candidate manifest SHA256:
`9ee498efe301a862908ac6c13ede33688ef458fba21dad4230aa947ba1877c33`.
Full world content identity:
`919468333dcc008e919c4ee82a3938ba43d9505605f05e508538fb34dac199a3`.
