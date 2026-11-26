# Compact coastal mineral composition

## Ocean boundary follow-up — 2026-09-12

Native59 shows a peaked ocean horizon: the finite water root's
`(800,16,800)` corner projects to pixel `(608.9674,155.0117)` in the recorded
bay view. This is a geometry boundary, not a reason to change exposure or
increase fog. The sections below retain the earlier mineral-material evidence.

The implementation extends only the exposed sides of existing
compact, single-root ocean meshes. Eight outward bands reuse each leaf's exact
original edge indices; mixed-detail neighbors retain matching endpoint chains.
The outer half-size is 1,800 m, beyond the existing complete-fog distance of
800 m for an eye inside the original 800 m half-root. No new terrain roots,
island or water mesh objects are introduced. The initial native60 geometry
candidate leaves the material, shader, camera and pond unchanged.

The collar has the same quadtree lifetime as its inner mesh. Culling remains
enabled, with existing bound objects expanded for all three components of the
actual wave displacement and refreshed from the live ocean wind uniform.
Non-finite/non-Float32 wind inputs are rejected; default wind is not assumed
to be an upper bound. These CPU bounds do not prove rendered seam continuity.

For that initial candidate, root passes 806 regression tests across 62 files, including 12 new cases using
actual World/Terrain/Water/Wind/QuadTree/Three classes, plus all four package
typechecks, production client/shared and server builds, and scoped lint/format.
The tests retain exact original geometry prefixes, mixed-detail endpoint chains,
outward winding/area, wind-dependent bound identities, repeated lifecycle and
synchronous removal/disposal reentry. No mock GPU or copied water generator is
used by the new suite.

The complete finest settled perimeter adds 16,384 triangles and 411,648 CPU
attribute/index bytes across the same 60 boundary meshes. A conservative
all-depth transition-coexistence ceiling is 25,216 added triangles / 640,896
CPU bytes, not a settled-count claim or native allocation measurement. Existing
parent/child transition overlap is retained, not declared fixed.

Native60 is **not visually accepted**. All 18 paired camera/daylight images
qualify against native59, and the old peaked sky/water outline moves out to
a straighter distant horizon. However, a conspicuous V-shaped water-color
band remains, plus a separate distant sky/fog mismatch. Extending the geometry
alone does not fix either defect. Root independently verifies all 535 current
source pins, 466 archives (36,271,394 bytes), 24 PNG hashes/dimensions and four
separate water/FogConfig preflight pins before further edits. Cleanup receipts
pass; zero GPU/page errors does not waive the 19 known cow/dagger failures.

Read-only attribution identifies the near band as seabed transmission, not a
collar seam: `(800,2.5,800)` projects to `(609.24,175.30)`, matching its apex,
whereas the original water corner projects 20.3 pixels higher. That sightline
hits water inside the old root before fog begins, with opacity about 0.83.
The background changes from terrain seabed to sky at the finite terrain edge.
All six recorded bay observations have no positive-area base mesh overlaps.
The next correction must reach zero deep-ocean transmittance on both original
and extended water, preserving the separate lake/pond path and shallow fade.

The far join has a separate source-order defect: the fog texture is prepared
in environment late-update, before the selected diagnostic camera is applied
at the main-render boundary. Visible sky and sampled sky fog can therefore use
different cameras. Native60 has no fog-camera matrix receipt, so this is a
proven ordering defect, not a measured pixel attribution. Prepare both at the
actual main-render boundary and verify their matrices in the next native run;
do not compensate by changing fog distances, colors or exposure.

Evidence: `asset-studio/game-test-integration/water-horizon01`, including the
paired static result and separate `after60-root-verification.json` attestation.
Native60 report SHA256:
`97c5f01b8fe3481f418a079a8a3b71737c5c7867edf1661babb55a2b1eadbba9`.

Camera rotation and
recentering in motion, actual draw/pixel cost, sustained GPU/frame timing and
final water art remain open. Enlarged correct culling bounds can make more
existing meshes visible; unchanged mesh count is not unchanged rendering cost.

### Native61: targeted band corrections verified

The ocean opacity graph now blends its existing shallow expression toward
exact opacity 1 over the existing 0.4–8 shore-distance transition, independently
of viewing angle. Current quadtree ocean vertices all carry shore distance 50,
so this applies consistently to original and extended ocean meshes. This is
not a new bathymetry-derived shallow-water calculation. The separate lake/pond
graph, ocean color/fog output and wave parameters remain unchanged.

Sky preparation now runs inside the actual main-render boundary, after camera
selection, for both direct and composer branches. It copies only required
projection fields/matrices into preallocated storage, not camera user data or
animations. It uses world pose and preserves the visible sky's rotation/scale.
Public render-target/face/mip and tone state are restored in failure paths;
a preparation failure prevents the main draw and further retries in that
session. This is not a claim that private WebGPU state recovers after an error.

Root passes the final 831-test / 66-file shared regression, all four package
typechecks, normal client/shared build followed by server build, and seven-file
lint/format. The capture retains all prior gates and adds read-only camera/RTT
brackets around the same 24 PNGs. Its 67 unique active tests pass (root's command
also explicitly included the imported prior runner tests, yielding 90 passing
invocations; these are not 90 distinct cases).

Native Apple Metal3/WebGPU, nonfallback: root independently verifies all 543
current pins, 474 archives (36,446,826 bytes), 24 PNG hashes/dimensions and all
48 fog brackets. The main/selected/fog projections and normalized orientations
agree; maximum observed orientation roundoff is 2.22e-16. All 18 static pairs
against native60 qualify, maximum phase delta 0.00380465 and exposure delta
0.00002632. These are CPU camera receipts around screenshots, not exact GPU
matrix/presented-frame timestamps. Observer overhead excludes performance claims.

Root and independent review of the actual bay/ridge PNGs find the V-shaped
seabed band and hard pale sky strip removed. The water reaches a continuous
soft horizon in these fixed views. Faint distant white sparkles/dotted lines,
shore contact, 360-degree movement/LOD continuity and final water art remain
open. The rest of the scene is still sparse and the ridge is too smooth and
repetitively cobbled. This checkpoint is not whole-scene or seamless-motion
approval.

Zero page/GPU/device errors; all 19 genuine content errors remain (14 rejected
dagger attachment attempts and five messages from one missing cow asset).
Overall run remains failed. Owned browser/processes/container close, all four
ports are free, and the two unrelated containers remain untouched. Source
review additionally found a pre-existing TerrainSystem→WaterSystem teardown
gap; current tests explicitly destroy the private water owner, so actual parent
teardown still needs its own repair/verification.

Native61 report SHA256:
`df2e4ee6426939dde3d97c64a52de90df65a89e7345d0810382b8fc797c5324d`.
External evidence: `water-horizon01/after61-root-verification.json`,
`water-horizon01/native-pair60-61.json` and the complete `compact-world-probe61`
capture, including `fog-screenshot-evidence.json`.

## Earlier coastal mineral checkpoint

Status: native probe52 complete; root's combined regression passes 426/426
tests across 41 files. The bounded coastal material change is verified, but
the shoreline still needs substantial visual work. No final art or GPU-cost
approval is implied.

## Visible problem and bounded change

Actual probe51 shows a nearly continuous pale rock outline around the island.
The first coastal surface pass redistributes part of that existing rock
contribution into the already loaded soil PBR layer. It retains more exposed
rock at the admitted western headland/ridge, varies the distribution using the
existing material noise, fades below the interior elevation, and applies a narrow
wet mineral response at the ocean surface.

Sea level, interior elevation and headland direction come from the already
admitted profile. They are not hardcoded world heights or a second terrain
definition. CPU ground color and TSL use the same detached field and matching
arithmetic. Full road/pond soil overrides remain last in the blend; the compact
terrain without this field and legacy materials retain their old behavior.

This changes the mineral contribution's albedo, roughness, AO and world-space
normal together. Wetness is limited to that contribution; it is not a global
exposure or saturation change. All six maps, fourteen surface samples, explicit
projection gradients, terrain geometry, water geometry, lighting, collisions,
functional tree identities and scene ownership are unchanged. Additional shader
arithmetic has a cost even without additional texture samples.

## Grass placement remains exact

The existing worker and synchronous generator consume rotation randomness only
after accepting a clump. Changing material-derived eligibility would change the
remaining candidate sequence, not merely remove coastal grass. That behavior is
not changed in this slice.

Instead, the original dirt/cliff weights and grass-support algebra remain
unchanged. Only the existing rock layer is mixed with soil; no bare-ground layer
is painted over the grass contribution. The four non-color buffers—positions,
rotation/scale/hash, tints and ground normals—are compared against the published
baseline in all six actual worker leaves, not inferred from equal counts.
Ground color is allowed to change. A future removal-only ground-cover pass must
preserve the original accepted RNG consumption and filter afterward, with
coordinated worker/synchronous verification.

## Verification and limits

The focused implementation run passes 31 tests in three suites. Twelve actual
CPU shoreline anchors have original cliff weight 1 and grass support 0. Candidate
soil contribution varies from approximately 15.3% at the western headland to
70.5% southwest; these are layer weights, not observed pixels. Tests cover
independent arithmetic, CPU/TSL parity, shifted admitted water/base levels,
continuous bounded transitions, full road/pond priority and exact worker
non-color hashes. The retained baseline requires no Git CLI/history at test time.
Root independently passes those tests within the complete 41-file regression,
including the unchanged 29-resource lifecycle and historical grass/terrain
fixtures, plus scoped lint/format/diff checks and all three normal package
builds/typechecks. All five source/test hashes still match the implementer's
freeze after those commands. Root also passes the entire launch validator
process suite: 32/32 with zero skipped/cancelled cases in 189.96 seconds.

The unchanged coastal ramp is still geometrically smooth. This pass does not
create craggy cliffs, shoreline foam, grove litter, village architecture or final
meadow detail. Existing native cameras cover wide and middle-distance oblique
coast views, but not a close oblique inlet/western outer face. Motion, close-up
material transitions, sustained GPU timing and minimum hardware remain open.

## Native evidence and art verdict

Unchanged runner32/study24 passes its study, spatial, island and presentation
gates on native Apple Metal3 WebGPU, nonfallback. Root independently verifies
all 468 current source hashes, all 399 archives (29,091,496 bytes), all 39 PNG
hashes and 1280×720 dimensions (38,358,150 bytes), plus exact standalone versus
embedded study/presentation JSON. The four separately attested launch/test
inputs are unchanged across the run.

The actual world retains 29 authoritative trees, six grass leaves and 2,281
clumps / 82,116 nominal grass triangles. All 67 art/lighting/zero-marker
observations and 11 restored HUD leases pass. There are no page, GPU,
uncaptured or device-loss errors. Owned browser/services close cleanly and
all four temporary ports are free. The whole run still FAILS exactly 19
content errors: 14 current-avatar dagger-fit errors and five missing-cow
load errors. These are not waived.

Root reviewed wide, campus-link, arena-campus and bank images. The ocean
rim is darker and less uniformly pale, but broad lawns, smooth slopes,
repeated terrain texture and missing architecture still dominate. Natural
lighting phases differ from probe51, so this is not a matched-lighting A/B.
The bank view is a service station, not a close ocean-contact view.

Evidence: external `asset-studio/game-test-integration/compact-world-probe52`.
Report SHA256:
`141d405b0d1bd5a205bc7bfcbf1ff03cba611051bf214d98242b65691cf30b01`.
Spatial JSON:
`484b2c42b0187171dfcf6233c0b4a36a5a6094407d26db85b1e7332b84ec65c1`.
Presentation JSON:
`c9f4e3929a4ecd94e10260b6f297bf4bbc7616ff0d8082473b0b345a4f4d60af`.
Static receipts do not establish motion quality, GPU timing, stream delivery
or production readiness.
