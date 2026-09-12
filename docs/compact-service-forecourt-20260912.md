# Compact service forecourts

Status: forecourt implementation and focused native review complete; final art,
animated interaction and performance acceptance remain open.

The bank and workshop now reuse the existing dirt/grass road mask for small
connected standing areas. These are surface paint, not new navigation edges,
colliders, service owners or geometry. The original six circulation paths are
unchanged. NPCs, stations, all 29 resource trees, terrain heights and the lodge
remain in their admitted positions.

| Clearing | Start X/Z | End X/Z | Width |
| --- | --- | --- | --- |
| Bank apron | 346, 320 | 350, 320.5 | 4 m |
| Clerk approach | 350, 320.5 | 354, 324 | 3 m |
| Shopkeeper approach | 346, 320 | 344, 323 | 2.5 m |
| Workshop apron | 334.75, 334.75 | 339, 334.25 | 3.5 m |
| Supplier approach | 336.5, 333 | 337.5, 331.5 | 2.5 m |

The clerk approach ends two meters west of the NPC. An earlier proposal ended
one meter farther east; checking every selected tree LOD, rather than only
LOD0, showed insufficient clearance after the mask's bilinear filtering halo.
Only the paint endpoint changed. No tree was removed or moved to pass the test.

## Verification

- Root independently passes **780 shared tests across 58 files**, including the
  existing resource lifecycle, terrain, path, physics, lodge and grass checks.
- Shared and client normal builds pass; client builds shared dependencies;
  server rebuilt last and verifies its resolved runtime. Shared/client/server
  typechecks pass, as do scoped lint, formatting and whitespace checks.
- The four changed/new runtime and test files match the reviewed frozen hashes.
- Original six path values match their independently retained baseline digest.
- 14,063 conservative footprint samples are finite, dry and level. Minimum
  height above the registered water surface is 12.419 m.
- Declared transformed bounds from all three LODs of the 16 actually selected
  resource models are checked. The full 256-square mask's nonzero texels and
  bilinear support envelopes leave at least **0.632 m** of static crown clearance.
  This is not animated wind/silhouette clearance or native visual acceptance.
- All five grass-worker output arrays are byte-identical before/after in the
  six checked leaves: **2,281 clumps**, including the unchanged campus count.
  The acceptance-dependent RNG is unchanged; this census is not a GPU measure.

## Cost and visual boundaries

There are five additional paths, 38 additional segments and 43 additional
points, giving 11 paths and 222 segments in total. Existing CPU road queries
and mask generation process more segments. No new texture, sampler, shader
branch, render pass, geometry or collider is introduced. The baked mask stays
256 by 256, covering 85.5 m, but its center moves 1.3 m west. Sampling 5,745
old-road positions outside the new clearings measures a maximum bilinear
influence change of 0.096905. Thus unchanged original path coordinates do not
mean unchanged pixels along every old road edge.

Native56 is a focused review of four lodge close-ups plus the retained bank,
anvil and campus-link cameras. Its 27 images do not replace the full
eleven-view island survey, actual player movement/contact, harvesting, a
performance benchmark or long-duration qualification. The harness preserves
camera/HUD restoration, actual Metal/WebGPU admission and every runtime error.

Root independently passes 133 applicable harness tests. Two frozen historical
cases are explicitly omitted because they assert superseded world data: the
old eight-floor case retains its unchanged single-arena replacement, and the
old six-road actual-producer case has a full eleven-road successor preserving
the real material/array identity and negative controls. Neither exclusion
waives a live renderer error or an ownership gate.

## Remaining acceptance

- [x] Inspect native56 exterior, entrance and interior images, and compare the
      bank/workshop/link images with native55. The workshop's shared standing
      area reads more clearly; the bank apron connects its services. Both still
      have unnaturally rounded edges and coarse cobble-like surface detail.
- [x] Independently verify all 27 PNG hashes/dimensions, 522 live source pins,
      453 source archives (30,789,650 bytes), camera restoration and owned cleanup.
- [ ] Fix the window/door trim topology defect revealed in the lodge close-ups:
      the shared multi-geometry merger copies indexed box vertices but discards
      their index sequence, producing incomplete/diagonal faces. Count/bounds
      and readiness tests did not establish correct topology. Add exact face/
      attribute parity and ownership regressions, then repeat native close-ups.
- [ ] Verify animated entrance/step traversal, actual interaction and contact.
- [ ] Measure startup and sustained rendering/thermal behavior; short RAF
      observations are not presented-frame or GPU-duration measurements.
- [ ] Continue the larger art pass: turf repetition, ground detail, building
      materials/composition, foliage, contact light and shoreline quality.

Passing these implementation checks does not make the current island AAA or
production-ready. Known cow loading and dagger fitting errors remain open.

## Native56 record and verdict

Actual Apple Metal-3 nonfallback WebGPU, 1280 by 720 at DPR 1, from
2026-09-12T00:59:06.531Z to 01:01:53.389Z. All seven intended views were
captured in three HUD forms, plus six baseline images; seven images remove
the stream HUD but retain the provisional diagnostic badge. The study's 43
lighting/material/marker observations and 24 lodge framing boundaries pass.
There are no page or GPU errors/device losses. The overall run still fails
the 19 existing cow/dagger errors, including the cow asset 404. No waiver.

Report: `asset-studio/game-test-integration/compact-world-probe56/report.json`,
SHA256 `907b5ea331e5decf51e664f23d4bd1b674ab60141a08565bf1def5bf64bdb76d`.
The owned browser closed, launcher exited normally, dedicated database stopped,
all four owned ports cleared and unrelated Docker services remained unchanged.

The lodge is **not art-approved**. Broken frame pieces need the topology fix;
the empty interior, flat walls, repetitive floor/roof detail and bare platform
also need a substantial art pass. Neither a new ground texture nor AO alone
will resolve these. Preserve this run as defect evidence rather than labeling
its structural study pass as visual acceptance.
