# Lodge trim: indexed topology repair

Status: code, source geometry, native CPU collision and focused Metal/WebGPU
visual repair verified. The lodge as a whole is not art-approved.

## Defect observed in native56

The focused exterior and interior images show broken, diagonal window-frame
pieces. The architectural `mergeBufferGeometries` helper concatenated position
arrays into a non-indexed result without consuming each source's index buffer.
A standard box has 24 distinct vertices but 36 indexed triangle corners. Its
raw vertex sequence describes eight incorrect triangles, not the intended
twelve; some triangles cross different faces and have reversed winding.

Window-frame, mullion and nested door-header/frame construction pass indexed
boxes to that helper. The later generator's conversion to non-indexed geometry
cannot recover indices already discarded by an earlier merge. The existing
mesh-count, bounds and readiness checks did not establish correct topology.

Root added an integration regression against the original built package. It
fails on the actual lodge's first window-frame triangle: geometric face normal
dot stored outward normal is **-1**, rather than greater than 0.99999. The
new procgen regression separately compares the real box's expanded attributes
against Three's native non-indexed conversion and retains the old corrupt
sequence as an explicit negative comparator.

## Repair and ownership

- Expand every indexed triangle corner in its original order when merging
  multiple sources. Preserve normal, color, UV and secondary UV values through
  the native accessors, including normalized/interleaved attributes.
- Generate missing flat normals only in the owned expanded output. Do not
  mutate borrowed source attributes, smooth across authored faces or flip winding.
- Validate triangle counts, indices, attribute shape and finite Float32 values
  before allocation/disposal. Bound aggregate source/expanded vertices and
  source count. Repeated source references contribute repeated geometry but
  are disposed only once when ownership is consumed.
- Keep the prior empty/singleton identity-or-clone contract. Remove duplicate
  disposal in four window helpers; the actual singleton lead-box path must
  return live geometry instead of disposing its returned alias.
- Do not change the separate dock/interior-lighting merge implementations,
  the admitted building descriptor/layout, materials, lights or physics policy.

## Measured geometry

| Role | Before triangles | Corrected triangles | Corrected CPU geometry bytes |
| --- | ---: | ---: | ---: |
| Floors | 4 | 4 | 464 |
| Walls | 600 | 600 | 55,352 |
| Roof | 20 | 20 | 2,112 |
| Window trim | 400 | 576 | 89,856 |
| Door trim | 92 | 132 | 20,592 |
| Total | 1,116 | 1,332 | 168,376 |

The fix restores 216 missing triangles and adds 33,696 CPU geometry bytes.
There are still five meshes and four material roles, with no new texture or
render pass. Cached layout and world-space envelope are exactly unchanged in
the source comparison. These counts do not measure GPU residency or frame cost.

## Root verification

- 128/128 tests across all six building/procgen test files pass.
- 781/781 shared tests across 58 files pass after rebuilding the actual package
  boundary; the previously failing actual trim winding regression now passes.
- Three native PhysX start/destroy/reinit cycles check every one of 708 trim
  faces against near-surface Three ray intersections: **2,124 comparisons**.
  Existing 192 interior floor rays, open doorway, walls, roof, no phantom
  walkable roof and actor-baseline return checks also pass.
- Normal procgen/shared/client builds pass through the client dependency build;
  server is rebuilt last and verifies resolved runtimes. All four package
  typechecks and all five changed/new source lint/format checks pass.

The ray checks compare static geometry and collision, not character movement,
step support while animated, visual pixel coverage, temporal stability or
performance. Repeat the exact native56 close-up cameras against the corrected
build. Keep native56 and its defects immutable as the before evidence.

## Next acceptance

- [x] Inspect corrected native57 window/door pieces from all four lodge cameras.
      Window perimeters and mullions are now complete rectilinear pieces rather
      than fragmented diagonals. The doorway remains open; its trim is still
      visually understated/recessed and needs the broader fitting/art pass.
- [x] Verify source/image archives and owned native-session cleanup.
- [ ] Continue the substantial lodge art pass: flat plaster, roof/floor detail,
      meaningful interior, scale/composition, platform and contact lighting.
- [ ] Qualify animated entry/exit, inventory preparation, interactions and cost.

Known cow asset loading and dagger-fit errors remain independent production
blockers. This repair does not waive them or mark the broader game launch-ready.

## Native57 evidence

The same seven views and camera recipes as native56 were captured in actual
nonfallback Apple Metal-3 WebGPU, 1280 by 720 at DPR 1. No new light, material,
texture, resolution or exposure override was introduced for this repair. Both
runs use the bounded natural-daylight window; they do not freeze the sun or
claim pixel-identical illumination and actor motion between runs.

Root and the independent operator verify **27 unique PNG hashes**, **529 source
pins**, and **460 source archives totaling 31,225,444 bytes**. All 24 lodge
framing boundaries and 43 sampled art/lighting/marker observations pass. The
actual rendered lodge census is 1,332 triangles and 168,376 CPU geometry bytes.
The active successor harness passes 54 tests with no skips/exclusions. Frozen
historical sources remain preserved, but their recursively imported old-data
test bodies are not claimed as a current-data suite.

The run spans 2026-09-12T01:20:35.889Z to 01:23:19.125Z. Report SHA256:
`316c9bd6a0571926faca31cb95d8a08ce00514667544bb085e60bc5ff3daf50f`.
Evidence directory: `asset-studio/game-test-integration/compact-world-probe57`.
There are zero page/GPU errors or device losses. The overall result remains
failed for the same 19 cow/dagger errors and cow 404; structural study success
does not discard these production blockers.

The browser closed, launcher exited normally, owned database stopped, all four
ports cleared and unrelated Docker services were left unchanged. Camera,
render and HUD leases restored. This lightweight run does not establish native
GPU lifetime accounting, sustained presented-frame performance or thermal
behavior. Seven no-stream-HUD images retain the provisional diagnostic badge.

Root's visual verdict: the broken-window topology is visibly repaired; flat
plaster, aliasing in roof/floor patterns, the empty blue-gray interior, sparse
platform composition and repeated turf still fall well short of the art target.
