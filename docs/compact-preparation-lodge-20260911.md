# Compact preparation lodge: geometry and movement groundwork

Status: opt-in geometry prototype and shared exterior-support fix implemented.
No lodge is installed in the world. Placement, native materials, collision
ownership and art acceptance are still required.

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
