# Compact preparation ground/material pass — 2026-09-10

Status: implemented development checkpoint. Probe12 exposed rendering defects;
probes13/14 visibly verify their correction. Ground composition remains unfinished.
This is not AAA art, frame-time, full-loop, streaming or launch acceptance.

## Implemented candidate

- Compact terrain uses real turf, dirt and rock diffuse/normal/roughness/AO data.
  Six lossless channel-packed 1024px PNGs replace the compact material's nine
  legacy biome-map allocations. There are ten surface sample sites across the
  top-down turf/dirt and three rock projections. This does not claim ten total
  shader samples: shared noise, road, light, fog and shadow resources remain.
- Packed RGB colour uses sRGB; normal RGB is non-colour data and packed alpha
  remains linear. Bitmap decoding explicitly avoids alpha premultiplication and
  performs a single Y flip. This follows the separation described in
  [Three.js colour management](https://threejs.org/manual/en/color-management.html).
  Actual GPU upload/appearance still requires browser evidence.
- Each material owns its textures. Loading admits all six exact SHA-256 digests
  and dimensions, records errors, times out, and prevents disposed/late results
  from publishing. The source originals remain unchanged. Packed files total
  9,452,737 bytes; six RGBA8 textures with full mip chains are approximately
  32 MiB, not including the rest of the game or staging/decode allocations.
- Compact grass bases use the real maps' linear mean palette and matching layer
  weights in main-thread and actual worker code. This approximates local diffuse
  colour, not every visible texel or final lighting. Ecology and placement weights
  remain separate; the existing very sparse stream grass is not qualified.
- Six curved preparation paths derive their anchors from admitted stations,
  water and arena floors. Existing road-mask rendering is now activated for the
  compact client/stream. Mixed widths use the same maximum-union arithmetic in
  the road producer, terrain and grass worker. Tile-boundary influence and mask
  bilinear footprint have tests. Paths do not relocate stations, grade heights,
  change physics or establish that agents actually follow these visual routes.
- Terrain receives and replays the actual road-mask producer's readiness event;
  teardown removes listeners and cannot clear another world's replacement mask.
- The stream retains 16 vertices per axis outside two preparation leaves; those
  two 100 m leaves use the admitted gameplay density of 64. Overrides are fixed,
  detached/frozen and only apply at maximum quadtree depth. Draw-call count is
  unchanged by this density change; CPU/GPU cost is not assumed free.
- Ocean-level chunks now use ocean material consistently in the compact profile.
  The elevated pond remains its own lake mesh, at the same position/radius/height.
  This is a material-ownership correction, not a finished water/shoreline pass.

## Executed source verification

- Shared: **515 tests / 39 files passed**, 17:25:08 start, 6.23 s.
- Server: **128 tests / nine files passed**, 17:26:46 start, 4.34 s; arena movement,
  collision/combat, cycle timing and preparation regressions. This is not a live
  multi-agent or real-money test.
- Launch asset validator: **13 tests passed**, 59.96 s. Its existing biome-map
  preflight has not yet been extended to the six new packed maps; the new client
  loader independently requires their exact bytes. Add deployment preflight.
- Shared/client/server typechecks passed. Fresh shared full/client/declaration
  build and server build passed. Build identity:
  `211a650a11e8087b91f618db1a1924b52ae0969d9d466c2e8397efc5c064fe6b`.
- Packing check reproduces all six images and their original source hashes;
  targeted source lint/format and diff checks pass.

The actual pond CPU comparison samples 7,921 positions against computed authored
height, not a GPU depth buffer or an end-to-end actor-grounding guarantee:

| Two preparation leaves | 16 vertices/axis | 64 vertices/axis |
| --- | ---: | ---: |
| Grid spacing | 6.6667 m | 1.5873 m |
| RMS height error | 0.283387 m | 0.079177 m |
| Maximum sampled error | 0.956358 m | 0.467569 m |
| Triangles, including skirts | 1,140 | 16,884 |
| Attribute/index bytes | 49,520 | 690,032 |

The remaining maximum error is significant. Do not call pond shape, actor
contact, water contact or the bank silhouette finished because RMS improved.

## Remaining art and integration gates

- [ ] Actual close/wide/moving WebGPU review with verified loaded texture bytes.
- [ ] Wet margins, irregular banks, rock formations, foliage composition and a
  coherent preparation setting. The new material intentionally bypasses old
  painted sand/shore overlays; replacement shore treatment is still required.
- [ ] Review and integrate the separate Blender workshop canopy candidate with
  explicit collision/access and split-roof overhead-camera handling. It is not
  currently placed in the live world; source and renders are local authoring data.
- [ ] Existing hospital-floor striping, avatar/equipment colour and fit failures,
  cow content error and canonical dagger metadata remain unqualified/unresolved.
- [ ] Representative frame/loading/memory measurements and full agent/stream loop.
- [ ] Complete source-license/provenance evidence for the reused terrain maps and
  proposed dressing assets. Hash locks establish bytes, not usage rights.
- [x] Cancel already-started, yielding road refresh work on teardown or
  supersession; reject detached/replaced tile, chunk, mesh and geometry owners.
  Eleven real lifecycle regressions cover these cases. This is not a general
  audit of all terrain async work or runtime road removal/rerouting semantics.
- [x] Extend launch asset preflight to the new hash-locked packed terrain kit,
  sharing its exact six-digest JSON with runtime. Missing and stale bytes for
  every packed map are rejected in isolated temporary fixtures.

No main merge, deployment or release approval. Runtime source and packed assets
must be checkpointed together; source Git does not back up local Blender/captures.

## Probe12 — actual evidence, not visual acceptance

The owned Chrome/Metal session ran 2026-09-10 21:37:45.005–21:39:53.589 UTC.
It retained 22 spatial PNGs from the same 11 cameras plus six baseline PNGs.
All six served texture bodies matched exact prelaunch SHA-256 and byte counts;
all 156 pinned inputs stayed unchanged. The inner spatial study passed all 45
initial/per-image material, two-leaf detail, road-producer and water-owner
observations. No page/GPU errors were recorded, cleanup errors were empty, and
the owned browser/stack closed with all four ports clear.

The overall session remains **failed**: the existing cow VRM 404 and 14 canonical
dagger fit-metadata errors remain recorded. The shader graph/CPU array receipts
do not prove a correct GPU texture allocation or pixels. In particular, the
following visual review exposed a road-mask allocation lifecycle defect missed
by those ownership checks; the next capture must establish the visible remedy.

Actual visual verdict: more surface detail and a recessed blue pond are an
improvement over probe11. However, broad repeating stony dirt blankets the
preparation area, paths are not traceable even over grassy ground, the pond is
still a circular bowl with a bright rim, and neon tree colours clash with the
darker ground. No art checkbox is closed by this capture.

Evidence in `asset-studio/game-test-integration/compact-world-probe12`:

- Report SHA-256: `b041f9134aad406fd7937f32b39d67615115f6a28676330eac349fda5bb2fddf`.
- Spatial study: `ea5dabc2200d2d4bf01e219905bb4410e2b61d25160f633c49371cc1fb23834e`.
- Launcher log: `cbfcaa776185654303e9b148ef64db895225d661a9ac4df3bbb42690784929ad`.
- Study08: `31310618397c3953f5c046ea3d0eb3f87b85ec21b8729c8bbc7adeb5d5438f78`;
  32 actual Node tests pass. Runner04 separately verifies the HTTP texture bytes.

The seven-file packed asset kit is committed and pushed on
`codex/duel-arena-launch-assets` at
`03f5fd5203271ac296bf0dd4d5a6ed7296501960`. GitHub author and committer both resolve
to `dreaminglucid`; remote branch equality and staged/commit secret scans passed.
All 26 original cloud-placeholder index flags were restored. No original texture
or unrelated asset was changed. Runtime source checkpoint follows the correction.

## Follow-up corrections and final source verification

- Compact meadow composition caps broad flat dirt patches at 12%, moderate-slope
  dirt at 20%, and retains full dirt selection on paths. Cliffs use geometric
  slope, not noise-distorted flat ground. Macro brightness variation is ±2%;
  dirt/rock normal strengths are 0.25/0.40. UV repeat and six-map/ten-surface-sample
  budget are unchanged. CPU grass-base palette uses the same layer controls.
- Road mask dimension changes now allocate a new DataTexture and replace the
  stable TextureNode's value before disposing the old allocation. Same-size
  updates retain allocation. Real Three sampled-node/binding tests cover
  1→256→1 replacement, disposal and old-world cleanup isolation. The previous
  image-only resize did not resize an already-created WebGPU texture.
- Corrected the compact world→view normal multiplication. The previous
  vector-first TSL transform used the inverse camera rotation: at the exact
  probe12 overhead camera, world-up became nearly downward after the incorrect
  round trip. Explicit matrix × direction now matches native camera arithmetic.
  Four actual camera-angle regressions retain Lambert-dot invariance. No
  exposure, lighting intensity or albedo brightening was used to conceal it.
- Road-generation events also refresh quadtree-only attributes. Every yielding
  refresh has generation, destruction and current-resource ownership guards.
- Final frozen source: **530 shared tests / 40 files passed**, 17:54:36 start,
  19.12 s; **128 server tests / nine files passed**, 17:54:53 start, 10.57 s.
  Shared/client/server typechecks, scoped lint/format and packing check passed.
  Launch validator **15/15 tests passed**, 76.34 s. Study09 **33/33 passed**;
  it delegates to the unchanged study08 function and adds the new source pins.
- Fresh shared full/client/declaration and server builds passed. New build ID:
  `9fb1c1f58d89e2cbe4c311724b8ac76ebaefdf2347dbf08767ec798317ea8e9a`.
  Probe13 is the matched actual-pixel follow-up described below.

## Probe13 — rendering corrections visible, shutdown check failed

The unchanged-camera study ran 21:55:45.296–21:57:55.218 UTC. All 22 spatial
images and six baselines are retained. The six served texture bodies matched
their hashes; all 160 pinned inputs remained unchanged; all 45 material/detail/
road/water and hospital geometry observations passed. No page/GPU console errors
were recorded. CPU hospital clearance remains 0.0199999 m, not a striping remedy.

Actual bank/hub screenshots now show the curved path network; the overhead island
is lit correctly rather than almost black. These are visible remedies, not an
inference from a shader graph. Ground is now too uniformly lawn-like; repeating
texture scale, irregular wet banks, grouped rocks/plants, neon tree palettes and
scattered stations still prevent finished-environment approval. Stream grass
still has zero observed anchors in the preparation campus and pond bank.

This session **failed**, independently of the retained cow/dagger errors: the
owned launcher reports one process-group inspection EPERM for its client leader
during shutdown. Its numeric snapshot records that exact PID in zombie state;
exit/close then arrive, no remaining groups are reported, browser closes, and
all four ports are clear. A later exact-PID read finds no owned launcher/server/
client processes. Do not reinterpret the failure as a clean teardown or weaken
the fail-closed policy. An unchanged-build repeat is pending.

- Report: `a3051d0785c043ad759e8acc554ed091a14712b2b647e468bb43de768b8ab675`.
- Spatial study: `86a112a64a8e929a6dba341c409dff7d17606199437c4757162c1dc9f0c3a48b`.
- Launcher log: `d99b50ecc0ae617a70967b7df20cade1f7305f5cac031d3f081f586e346ab9d2`.
- Study09: `7cda127be3f169841f6b75036fc1946362cd2e645b06de6583b32122eb7298da`.

## Probe14 — unchanged-build repeat

The same build, study, observer and runner ran 21:58:56.477–22:01:06.147 UTC.
All 22 spatial/six baseline images are retained; the visible path and overhead
lighting fixes repeat. All 160 source pins remain unchanged and six actual HTTP
texture bodies match. All 45 material/detail/road/water observations pass. No
page/GPU console errors were recorded. Launcher exits 0, shutdown reports success
with no failures/remaining groups, browser closes, database exits and all four
ports are clear. Cleanup errors are empty.

Overall status remains **failed** because cow-content and canonical dagger-fit
errors remain. The successful repeat does not resolve or erase probe13's
intermittent shutdown inspection failure. No visual/performance gate was relaxed.

- Report: `21fc51b7fe8c8f866c13d2380a4209692ba1e063c85ed41cc49b4c88e404e502`.
- Spatial study: `7815ee393d2aab622245793b91ed8fc561562884a3497dff1c5206890ead98e4`.
- Launcher log: `029c904c75de0066856d4313463b2845d1640d4184b72294c9e62f8b8c290fee`.

Runtime source checkpoint: `ed8ce253689a289a2952488dd897a8a7b1bf7672` on
`codex/sol-duel-stream-launch`, 25 explicitly scoped code/test/contract files.
Normal commit hooks ran; all 160 actual capture pins are still exact afterward.
The paired assets checkpoint is `03f5fd5203271ac296bf0dd4d5a6ed7296501960`.
Unrelated working-tree changes and original source assets remain untouched.
