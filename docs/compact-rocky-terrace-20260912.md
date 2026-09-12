# Compact rocky terrace and photographed rock candidate

## Scope and visual acceptance

This is a combined landform/material candidate, not a claim of final art or an
isolated material A/B. The previous ridge is too uniformly rounded and the old
rock surface reads as cobbles. The candidate adds a crest, a 10m traversable
face and a shelf to the existing compact heightfield, with a connected fractured
rock surface. It adds no separate cliff mesh or extra terrain tessellation.
No shoreline, arena, campus, navigation policy or resource-tree replacement is
authorized by this slice.

The new active profile is `compact-duel-island-v5` / `compact-island-sculpt-v4`.
The previous v4 profile remains a numeric regression fixture, not a second
launch world. Terrace parameters participate in strict CPU/worker admission and
the complete world-content identity. Grove/lodge bindings must match the exact
corresponding profile; the existing authoritative tree identities and anchors
remain unchanged.

The offline 10m-face study produced a maximum existing-mesh/CPU height difference
of approximately 0.330m over its sampled candidate region; this is a sampled
representation measurement, not a maximum-error guarantee over continuous
terrain. The face is traversable under the existing slope rules. Neither a
texture nor a heightfield creates an overhang or an impassable wall.

## Source material and runtime budget

[Rock Face 03](https://polyhaven.com/a/rock_face_03) is provided by Poly Haven
under [CC0](https://polyhaven.com/license). Its published width is approximately
2.7m. Photography: Dario Barresi; processing: Rico Cilliers.

Four original 1024-square 16-bit PNGs are retained unchanged in the nested asset
repository at `terrain/textures/polyhaven-rock-face-03`. Portable provenance
records official download URLs, byte sizes, publisher MD5 and locally computed
SHA256. Original source bytes total 15,275,444; they are build inputs, not
additional runtime texture requests.

The existing packer rounds each 16-bit sample to RGBA8 before exact channel
packing. It does not use embedded gamma/ICC tags to transform normal, roughness
or AO values; it does not normalize normals or change orientation. This is
lossy relative to original 16-bit precision. The original and no-rescale
reference paths both use pngjs: the every-channel check qualifies its quantizer,
not an independent PNG decoder.

The replacement runtime pair is 5,486,790 transfer bytes, an increase of
2,227,445 over the previous 3,259,345-byte pair:

- Albedo RGB / roughness alpha: 2,593,468 bytes,
  `97f2d36833a7ce119d021cfa9728c42d292044297b172772c02f07f34403311a`.
- OpenGL normal RGB / AO alpha: 2,893,322 bytes,
  `056c1754f2e2315a22480025ffe798497d6674fc76b05d8c7f42b3c928268aa4`.

The runtime still owns six 1024-square RGBA8 maps and samples fourteen surface
projections. Rock alone uses `1 / 2.7` repeats per metre on its three world-space
projections; grass and dirt keep their independent scales and exact packed
bytes. Rock normal strength, roughness floor, AO strength, lighting, exposure,
color-space handling and single bitmap Y flip are unchanged. The CPU palette
uses the actual packed rock's linear mean. Equal texture dimensions/sample
count do not prove equal transfer, cache behavior or GPU cost.
The total packed PNG payload is now 16,267,403 bytes; compressed texture intake
and cold-loading measurements remain required rather than treating this source
selection as the final shipping transfer format.

Ordinary `--check` follows both installed source selections. Explicit legacy
grass and rock reproduce the original outputs; Grass004 plus legacy rock
reproduces the previous grass checkpoint. Unselected installed layers must be
byte-identical, never silently regenerated. All inputs validate before writes.

## Verification in progress

Seven packer tests pass, including original identities and corruption rejection,
portable provenance, historical generation, every quantized/packed channel,
profile-free derivative chunks and no-write installed-source checks. Independent
source review verifies original/output hashes, runtime digests, palette and
projection/channel semantics. These are CPU/source facts only.

The native successor must retain the previous capture's actual world-space
west-ridge eye and target. The old recipe recomputed camera height from terrain;
using it unchanged after sculpting would move the camera and invalidate an exact
paired-view claim. Keep natural time progression, strict daylight/exposure
tolerances, actual nonfallback Metal/WebGPU, resolution and all error gates.
Record changed grass placement rather than assuming equality from leaf counts.

Root integrated verification passes 870 unique tests across 71 files (868/70
plus the two new integration cases), four package typechecks and scoped
lint/format. The normal client build including shared succeeds, followed by the
server build last. All 35 changed source/test/asset freeze pins remain identical
afterward; external `rocky-terrace02/before62-root.json` records the exact scope.
All 29 actual resource entities, 12 source-owner generation results including
eight seeded trees, 11 paths and 29 bounded BFS harvesting routes remain exact.
There are 3,855 unchanged functional height checks. Ten macro-detail leaves
retain 84,420 triangles / 3,450,160 attribute-index bytes; only two western
grids change. The fixed six-leaf grass census increases 2,281→2,298, while the
two affected leaves together increase 503/632→520/657; the second leaf is outside
that fixed six-view census. No density or RNG algorithm changes are involved.

Pending: native appearance review, close oblique rock contact, repeated-pattern quality, motion,
mips, traversability presentation and actual GPU/presented-frame cost. The
existing cow/dagger failures remain launch blockers and must remain visible.

## Terrain-owned water retirement

The separately bounded lifecycle fix makes TerrainSystem retire its private
WaterSystem after unregistering/discarding water visual geometry. The actual
r186 reflector's public disposal path retires its per-camera targets; it does
not own the global fog RTT. Concurrent terrain initialization shares one owner;
retirement during asynchronous water setup prevents late scene/preference/timer
publication and defers that exact owner's destruction until setup settles.

Eight new actual-class CPU cases cover normal parent teardown, concurrent init,
pending/partially-created resources, original failure identity, partial scene
publication and synchronous event reentrancy. Native texture work cannot be
cancelled by synchronous teardown. CPU disposal events are not proof of GPU
driver-memory drain or a completed native restart/soak qualification.

## Native62 evidence and selection

The combined candidate is selected as the better working base after actual
native61/62 matched views, not as final island art. The rock reads as fractured
surface rather than rounded cobbles, and the crest/scarp/shelf is legible in the
wide campus view. The long regular cut and smooth lip still need organic breakup;
broad bare lawns, isolated tree crowns, sparse oversized grass blades and large
paved platforms remain visually weak. The roof's diagonal striping is present
in both captures and remains a separate review item. No character, animation,
shore-contact or whole-scene art approval is implied.

Root and independent audits verify all 561 current pins and all 492 archives
(54,513,418 bytes), all 24 PNG hashes at 1280×720/DPR1 (21,672,314 bytes), exact
fog sidecar equality and all 48 fog snapshots. All 18 paired image records pass
exact actual-camera equality and the unchanged daylight/exposure tolerances.
Maximum phase delta is 0.009889101908333253; maximum exposure delta is
0.00010033105620343985. This is within the declared tolerance, not pixel-identical
sun/wind/water. The renderer is genuine nonfallback Apple Metal3 WebGPU.

There are no page/GPU/cleanup errors. The study passes, but the overall run stays
failed for the same 14 dagger-fit attempts and five messages from the missing
cow model. Owned Chrome, launcher and temporary services close; all four owned
ports are independently verified free and both unrelated Docker containers
remain. Static capture does not verify driver-memory drain or sustained frames.

Evidence: external `asset-studio/game-test-integration/compact-world-probe62`.
Report SHA256:
`ec8dd8fdc8d66604680ab497c1a438f2320ed8d3abaa55cdfe64e1fe0c437ee8`.
Fog sidecar:
`06f3f9d7ac716f9e78d378721c8cd2db946e9645b270e41fb168e6103cface30`.
Root preflight and independent audit are in sibling `rocky-terrace02`.
