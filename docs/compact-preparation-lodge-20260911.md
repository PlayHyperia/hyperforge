# Compact preparation lodge: geometry, ownership and integration

Status: integrated candidate now observed in native WebGPU probe55. Shared
admission/layout/navigation, native materials, exact triangle physics and
teardown are implemented. Focused exterior/interior art review, gameplay foot
contact and sustained performance remain open; this is not production acceptance.

## Current integration candidate

One exact optional manifest descriptor admits the qualified (398,370) pose,
original recipe/seed and solid platform height. The descriptor changes full
world content identity; it cannot be added/removed after startup admission.
The current world-config SHA256 is
`2ea04f60a016da3681e2340be6c406d4a923b30b1e6c2c61494ea6df1d8604d9`.
No tree, road, terrain, bank, other service or duel return mark was moved.

TownSystem publishes its cached layout only after exact collision registration,
without generic towns, generated NPCs or new grading zones. The explicit
non-walkable-roof policy omits the synthetic flat roof and rejects navigation
at that absent floor, while leaving ordinary building behavior unchanged.
Lifecycle guards cover duplicate startup, cancellation, reinitialization and
borrowed collision IDs.

Normal and broadcast clients register the same small visual owner after
manifest admission. It generates five meshes / 1,116 triangles / 134,680 rendered
geometry bytes, four native WebGPU PBR material roles and no private lights,
image textures or frame update loop. Warm plaster, timber, stone plinth/floor
and muted shingles use the existing procedural material factory. Prebaked
interior vertex lighting is disabled; scene illumination/fog is authoritative.
Only the floor uses the movement-picking layer; the roof/walls cannot be clicked
as terrain. The private generator now retains the global primitive cache on
teardown, while the existing default whole-cache disposal remains unchanged.

Interactive clients cook five actual triangle meshes; broadcast clients create
no physics nodes. Frame meshes are nonindexed, so the caller supplies private
sequential-index collision views of their exact position arrays, without
rewriting rendered geometry. Generic closed-door boxes and the stock renderer's
flat-roof collider are never used.

Real installed-package PhysX tests pass three lodge start/destroy/reinit cycles,
doorway misses and wall/roof hits, all 64 interior floor rays each cycle,
and native scene actor counts returning to baseline. CPU scene tests verify
the full measured envelope, picking layers and one-time geometry/material
disposal. These tests discovered the nonindexed-frame cooking defect before
runtime promotion. Separate actual-native node tests exposed and repair owned
transform/shape-flag/filter/mesh-scale temporaries surviving teardown; shared
cooked-mesh references and other live shapes are preserved. Borrowed PhysX
member-wrapper caches and arbitrary malformed mesh cooking are not claimed
fixed.

Root verification of this candidate: 776/776 shared tests in 57 files,
56/56 generator/style/lifecycle tests in four files, all four normal package
builds and all four package typechecks, scoped ESLint/Prettier and diff checks.
The shared run includes the previous 651-test terrain/resource/light/support
set plus the new lodge, native physics, grass-prototype and adjacent town cases.

Native harness35/study25 has 125 applicable passing tests. The command explicitly
excludes the frozen historical test named `v6 preserves exact v5 live subjects,
bounds, identity and camera-floor contract` (study06.test.mjs:32), which requires
eight floor objects from the obsolete multi-arena layout. Its retained
study14.test.mjs replacement checks the same subjects/configuration and the
three correct floor objects for the single arena. This is not an unfiltered
historical-suite pass. The actual prelaunch closure is 503 pins / 446 archives,
30,364,016 archived bytes, with twelve observed equipment-file additions reserved
inside the explicit 515-file cap. Successor closure04 increases the former cap
by exactly three to retain the new runner/test/closure sources, with no historical
source exclusions or deleted evidence. This is an evidence-file limit, not a
production rendering budget.

Focused in-game material/composition review, animated door/floor/step contact,
interior visibility and measured GPU/thermal cost remain required. The sections
below preserve both the current native evidence and the earlier groundwork with
their original scopes.

## Native integration evidence: probe55

Runner35's genuine readiness wait observed the initialized town owner without
a published lodge, then actual shared collision/layout and the attached visual
3.810 seconds later. No startup method was invoked by the diagnostic. This
confirms the earlier avatar-ready snapshots were premature in this execution.

The actual Apple Metal-3 non-fallback WebGPU device rendered at 1280×720/DPR1.
All 39 PNGs have the expected dimensions, including eleven no-2D-stream-HUD
views (the provisional observer badge remains). The root reviewed the baseline
world/kit, bank, anvil and campus-link images: the building is plainly visible
on the lobby platform. Broad repetitive turf, sparse service composition and
large exposed pads remain visible deficits. Distant building visibility is not
close-up material or interior acceptance.

Study, lodge ownership and presentation checks pass, with exact camera/HUD
restoration. The two lodge receipts retain one owner and the same five meshes,
four materials and matching collision data. Root independently verifies all
515 source pins and 446 archived bodies / 30,364,016 bytes. No page/GPU/device
errors occurred. All owned processes, browser and database shut down cleanly;
all four ports are free, and unrelated Docker services remain unchanged.

The whole run remains **failed**: fourteen canonical dagger-fit metadata errors,
five cow-load errors and the cow asset 404 remain unchanged launch blockers.
This does not establish native character traversal, sustained FPS, GPU cost,
thermal stability, close-up roof quality or usable interiors.

Immutable external evidence in `asset-studio/game-test-integration/compact-world-probe55`:

- `report.json`: `5bdc7bf7297f8aaec4a13e145f3c1bc83efa2fa06e4432421a3d08c2c808c197`.
- `compact-lodge.json`: `18d5c3393bc05ce109cddc26ef74c6f2b064c7e87702505eaf88df08ca3877f9`.
- `spatial-study.json`: `410e6f77dbd95675416a1ff1970a751e2fcf5e6832fd1e9f3cfe611c54c18422`.
- `compact-presentation.json`: `a44da113fe352d9774b67e5020b335e7b3e9071bb94bc14c9f0a166db858ba82`.

## Preserved first native attempt

Probe53 stopped before planned captures because runner33 still asserted
`towns:false` for preparation broadcasts. That older absence policy conflicts
with the intentionally admitted compact-only TownSystem owner. This is a
harness admission omission, not evidence that the lodge rendered correctly.
The successor must verify the exact single lodge owner and reject generic
towns/NPCs/POIs, not merely permit any town system.

The failed report SHA256 is
`94516194747af2d5eb380e7c6d54c52e7afcc9872b707d4e2ccfb8ed84e4ee8e`.
Its 498 source pins / 441 archived bodies are verified unchanged. Actual Apple
Metal-3 non-fallback WebGPU initialized at 1280×720/DPR1, with zero page/GPU
errors, but the only screenshot is a loading-overlay failure capture; there
are no planned images, HUD leases or lodge qualification receipts. Five cow
load errors and the cow asset 404 remain; the dagger observer stage was never
reached, so this is not another 19-error full-cycle report. The owned browser,
launcher and database shut down cleanly, all four ports are free, and existing
unrelated Docker services were preserved. Probe53 and its executed sources stay
immutable.

Probe54 also stopped before captures, this time at runner34's exact ownership
gate: `towns` and the dedicated visual system were registered, but both the
shared lodge record and collision record were still null. Report SHA256:
`a895e375ab93ba9518981e6acc9b91b1c6204ab65bdeeaa677174c25e6742cd0`.
Its 500 pins / 443 archives are unchanged and owned cleanup passed. No page/GPU
errors occurred; five cow errors and its 404 remain. No equipment or study stage
was reached. This report is not proof of a permanently stuck lodge owner.

Source ordering explains why the old avatar-readiness boundary is insufficient:
ClientNetwork connects during `init`, while World later awaits sequential system
starts; TerrainSystem can await representative shader precompilation before the
late compact town/visual owners start. Neither loaded avatars nor loader progress
means the lodge is published. The successor must wait finitely for genuine
shared and visual readiness, preserve exact admission assertions, and record
the actual state on timeout. It must not invoke startup itself or waive errors.

## Why this slice exists

Native probe52 still shows an empty service lawn and exposed preparation pads.
A useful village requires buildings that render in both ordinary and streamed
views, preserve service access, and use the same layout for navigation and
physics. Simply enabling the existing procedural town renderer is unsafe:

- Streaming skips the town owner; normal clients do not register building
  rendering. Movement consumers already obtain collision through the town owner.
- Generic town activation also brings roads, grading and NPC behavior outside
  this one-building scope.
- Collision synthesizes a walkable flat roof, unsuitable for a gable.
- The existing building PhysX perimeter helper creates solid walls across doors.
- The first stock-bank candidate overlaps a conservative tree envelope and
  generates counter geometry without corresponding furniture collision.

The intended integration is one admitted, identity-bearing compact lodge
descriptor; a compact-only collision/layout branch without generic town/NPC
generation; and a small client visual owner consuming that exact layout.
Existing exterior banking services remain where they are. No manifest or
terrain/resource position was changed in this groundwork.

## Exterior support repair

The first actual 8m building study exposed lower entrance steps buried below
the already-flat service terrain. The raw geometric ramp reported offsets
−0.39375m and −0.9m, and player grounding selected them ahead of solid terrain.

The shared resolver now selects the higher valid exterior step or known
terrain/bridge/platform support. Both authoritative player support and client
player interpolation use it. Interior floors/stairs keep precedence; existing
unsupported negative floor indices remain unsupported rather than gaining a
new basement policy. Exposed negative-local steps still work above lower ground.
Unknown/nonfinite exterior support fails closed and the actual client retains
its authoritative Y. No raw collision geometry or non-player interpolation was
changed. Ramp approximation and native foot contact remain separate checks.

Root independently passes 225 tests in six suites, including real World,
TerrainSystem, BuildingCollisionService, ClientNetwork and walking/arrival
interpolation. No mock height implementation substitutes for the actual owner.
The combined terrain/resource/lighting/movement run subsequently passes
651/651 tests in 47 files (20.31 seconds); all earlier coastal and grove gates
remain in that run.

## Bounded gabled geometry

The existing generator now supports opt-in `roofStyle: "gable"` and
`includeProps: false`; default flat roofs and automatic props are unchanged.
The prototype is limited to one complete rectangular 4–32m floor, no basement,
and a bounded integer foundation step count. Unsupported box LODs are rejected
instead of silently replacing the pitched silhouette.

The roof has a closed 32-degree shell, 0.45m eaves, solid end walls and timber
verge/eave trim. Meter-scaled slope UVs and separate cap/edge projections avoid
stretched or collapsed faces. End walls meet the exact roof underside while
overlapping the rectangular wall below. No new texture, material, light, render
pass or scene owner is created by this geometry helper; the future renderer
must supply and qualify those explicitly.

Root passes 55 tests across the generator, style mappings and six new gable
cases. An independent reviewer also passes all six new cases after correcting
mixed-index merging, degenerate cap UVs, the end-wall seam and input bounds.
Tests cover closed outward-facing solids, nonzero triangle UV area, ray-tested
roof/end-wall contact, nonempty merged wall/roof geometry, omitted props,
unchanged layout and explicit-default geometry equality. These establish CPU
geometry behavior, not visual quality, final materials or rendered contact.

Normal procgen, shared, client and server builds and all four package typechecks
pass. Scoped lint/format/diff checks pass. Native probe52 predates this slice;
its source closure must not be cited as testing these changes.

## Required before installation and approval

The alternate gabled bank-side candidate at (354,316) is also not approved.
Its actual full envelope is approximately 9×11m, with 1,116 triangles and
134,680 geometry bytes. All three external service routes succeed, but the
bank–altar path crosses the proposed floor and the bank–lobby path band also
overlaps. One tree's conservative all-LOD envelope overlaps the roof; this is
not proven triangle intersection. No path or tree was moved to hide the issue.
External `asset-studio/compact-bank-lodge01/report03.json`:
`430d0745fe2473f5291d41858055d5122417d9446be0ab0f17d790590acac693`.

The deliberate preparation-lobby candidate at (398,370) passes bounded CPU
placement checks. It uses the actual solid platform Y=28.8393015231, not the
navigation terrain 2cm below it. The full envelope is X393.5023–402.4977 /
Z365.55–376.55, at least 2.05m inside the lobby boundary. No current tree,
station, NPC-clearance, path, hospital or combat-floor envelope conflicts remain.
All nine BFS routes from the three return/egress marks to campus, arena and door
targets succeed; return supports remain unchanged and all 64 interior samples
resolve to the floor plus player clearance. Root independently verifies all 32
named current source pins and the nine route receipts.

This is still not native contact, PhysX or installation approval. The study
retains the first candidate's exact layout recipe/seed and changes only its
position, gabled option and omitted props; a different seed is not this tested
layout. External `asset-studio/compact-bank-lodge01/report04.json`:
`5caff823bf8948c5bd360d40efcaec5b3dc47c074ba92438b655f895214c0c30`.

- Select and verify one full foundation/eaves/step footprint against current
  paths, pond, service approaches, trees and retained terrain; no blind placement.
- Validate/freeze its manifest descriptor and content identity on client/server.
- Share the exact layout and transform through normal collision ownership;
  explicitly disable the synthetic walkable flat roof for this lodge.
- Derive physics walls from actual door/window segments, not the closed
  perimeter-box helper. Test real approach and doorway movement.
- Resolve the structural floor versus 0.01m visual floor offset deliberately.
- Create native PBR materials with scene lighting/fog and bounded shared
  ownership; do not compensate by introducing private lights or baked tint.
- Prove ordinary/stream registration, late-start/destroy safety and complete
  owned teardown; do not create extra bankers, towns or decorative resource trees.
- Review native roof silhouette, materials, light/shadow and camera occlusion.
  Measure actual rendering cost and transitions before claiming scalability.
