# Compact coastal mineral composition

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
