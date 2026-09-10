# Sculpted compact island checkpoint — 2026-09-10

Status: development candidate, **not AAA, performance or production approval**.
The compact island is the only target world. Legacy numeric algorithm fixtures
are regression tests, not a requirement to retain a second playable island.

Paired runtime-assets revision: `1545350745e7110ddc4d3a39f2dbf7856432ad10`
on `codex/duel-arena-launch-assets`. It changes only `manifests/world-config.json`
and requires the corresponding game algorithm implementation. No deployment or
main merge is included; this is not a standalone asset-only release.

## Implementation

- A versioned `compact-island-sculpt-v1` algorithm / `compact-duel-island-v2`
  profile replaces the active compact candidate's noise-driven biome landforms.
  An authored western ridge, lower coastal hills and broad working meadow share
  a continuous seabed transition. Periodic coastline variation avoids an angular
  seam. This is deliberate shaping plus procedural detail, not simulated erosion.
- The factory is shared by main-thread height/mask sampling and actual generated
  tile/quadtree workers. Tests also execute its minified, name-preserving bundle
  in a fresh VM; helper serialization cannot silently depend on external state.
- The compact candidate uses one forest biome, eliminating the inherited
  snow/canyon/forest partitions and their foliage snow treatment. Existing tree
  species palettes and textures are unchanged; this does not qualify all foliage.
- The 400 m nominal envelope and all station/resource/arena coordinates and
  authoritative functional grades remain. The coast falloff is wider and raw
  meadow height is nearer the work areas, reducing the need for deep grade cuts.
- Grass installation projects accepted anchors onto the exact retained
  Float32 terrain triangles, in O(1) per anchor during bounded installation.
  Immutable geometry revisions bind worker tickets, surface availability and
  installed instances. Late results cannot attach to replaced terrain; child
  surfaces are withheld while an overlapping ancestor remains visible.
- Installed projected heights/normals are separate from retained worker
  heights/ecological normals. Projection rechecks water clearance and exclusion,
  compacts every per-instance attribute consistently, and adds no per-frame
  raycast. Geometry validation happens before scene publication; a rejected
  geometry is disposed without leaving an orphan mesh.
- A compact-only roughness candidate reuses existing texture samples and layer
  weights with a bounded distance fade. It adds no texture maps, normal-map or
  height displacement. Albedo is not used as fake bump geometry. True surface
  normals/PBR assets and final material art direction remain open.
- Terrain resolution, grass density/range/LOD, lights and upload limits are
  unchanged. This is not a measured performance claim.

## Verification before the first live attempt

- 273 shared tests / 26 files and 273 server tests / nine files pass. These are
  different suites with coincidentally equal totals; earlier subsets overlap.
- Shared/client/server TypeScript, fresh shared/server builds, scoped lint and
  formatting checks pass. Study06's 14 pure tests and 13 launch-validator tests
  pass; these cannot replace running the browser.
- Actual main/worker/chunk height parity covers 32,768 samples in eight regions,
  including extra shore coverage. The source preparation topology check retains
  all 59 targets, maximum 30 tiles / modeled 5.4 s run time. This is not a live
  agent preparation, transaction, navigation or duel-cycle test.
- Retained-grid tests include 548 actual Three mesh/ray comparisons, the exact
  archived probe08 failing anchor, delayed results, replaced terrain, invalid
  publication and camera return. Full blade footprints and GPU wind are separate
  visual acceptance work.

## Retained failed first attempt: compact-world-probe09

The actual Chrome/Metal/WebGPU run on 2026-09-10 20:20:01.767–20:20:55.448 UTC
**failed before spatial captures**, because the material detail strength was 0
instead of the compact profile's required 1. Generator initialization tried to
set a uniform before the terrain material existed; later material creation kept
its default-off value. The admission guard was correct and remains unchanged.

The attempt retains 37 successful HTTP custody receipts and six baseline PNGs,
but **zero spatial views or grass observations**. Zero grass counters are vacuous,
not a contact pass or evidence that grass disappeared. Page/GPU errors are zero;
the missing cow model and fourteen canonical dagger fit errors remain recorded.
All 125 pins matched at completion, 100 archived copies verified, browser and
owned stack closed, four owned ports free and cleanup errors empty.

| Probe09 receipt | SHA-256 |
| --- | --- |
| report.json | `a7073c1675368bc51372e804ced835b42b5ce9d3592a2d8952ef434796070e91` |
| spatial-study.json | `35aa9ffba97b6b9618d7d09548615dfc0ea01a0cee44ea92ca6493b1401535f4` |

Evidence lives locally under the parent workspace's
`asset-studio/game-test-integration/compact-world-probe09/`; ordinary source Git
does not back up the large capture archive. Earlier failed runs remain failures.

The correction applies the profile option to the actual newly created material
before publication or shadow setup. Three new tests exercise real TerrainSystem
initialization followed by its actual client material method, the reversed order,
and a per-instance legacy-profile fixture without changing global admission.
These CPU tests do not impersonate a browser. The final combined shared run passes
276 tests / 27 files; shared typecheck and fresh shared/server builds also pass.

## Actual corrected WebGPU evidence: compact-world-probe10

Ran 2026-09-10 20:26:08.616–20:28:14.555 UTC in actual Chrome/Metal/WebGPU at
1280×720, DPR 1. The same immutable study06 and unchanged camera/admission rules
complete 11 views / 22 spatial PNGs plus six baseline PNGs. The actual compact
material has detail strength 1. The diagnostic retains 36 custody receipts; it
does not exercise the real betting keeper, streaming or full agent duel loop.

The **inner spatial study passes; the outer run still fails** on the missing cow
model / five unexpected console errors. Fourteen canonical dagger fit errors
remain release blockers. Page/GPU errors and cleanup errors are zero; all 125
source/build/asset pins remain unchanged, the owned browser closes, PostgreSQL
exits and ports 3333/5555/57831/9236 are free.

- Twelve unique resident anchors, observed repeatedly around 22 captures:
  528 instance inspections and 525 independent triangle rays, **not 528 plants**.
- Original computed-height maximum error `9.110750553986691e-7 m`; original
  ecological-normal maximum component error `6.663996851563603e-8`.
- Installed-to-retained-surface maximum height error `6.690667397890593e-7 m`;
  maximum normal component error `2.6112113360454714e-8`. No surface-identity,
  installed-height/normal, computed-height/normal, water or exclusion violations.
- Independent retained-triangle rays: no missing hits or 0.05 m / strict
  0.0001 m contact violations; maximum absolute gap `6.690665941277985e-7 m`.
  Projection moves one accepted anchor as much as `0.17448806762695312 m`
  from its mathematical height, showing why computed agreement was insufficient.
- Preparation-campus and pond-bank regions still have **zero observed anchors**.
  This is not a density, individual-blade, wind, pixel-visibility, moving-camera
  residency or performance pass. The static observer is intrusive.
- One one-anchor mesh changes its visibility flag during the hub diagnostic
  image; all geometry/count/LOD/surface revisions remain stable. Thus only 21/22
  capture grass-state stability flags are true, explaining 525 rays rather than
  528. Region summaries and repeated counts independently recompute exactly.

Matched probe08/probe10 wide, hub and pond images show a real but limited
improvement: the harsh biome partitions and deep grade cuts are gone, foliage
no longer has the inappropriate snow overlay, and the ground is coherent.
It is still an underdressed blockout: large empty grass/dirt expanses, flat/blurry
materials, a circular puddle-like pond without a convincing bank, weak scale and
path hierarchy, and visually unresolved water-tile edges / offshore structures.
These images do **not** meet the requested AAA-quality bar. More shaping noise or
roughness arithmetic alone will not finish them.

The distant hospital floor also shows green cut-through bands that were not
visible against probe08's white terrain. A dense CPU reconstruction of the actual
100 m / resolution-16 chunk finds no hospital-footprint crossings: 258,621 samples
at 5 cm spacing retain at least 0.019999924 m separation. Conventional depth at the
recorded wide camera gives that 2 cm separation less than one nominal 24-bit depth
step; the near view has several steps. This supports depth contention, not a
confirmed new terrain penetration. A local floor-only rendering correction and
another actual distant-view comparison are required; do not move physical floors
or alter navigation to conceal it.

An exact follow-up clips every production main triangle against the complete
28×23 m hospital rectangle: 48 intersecting triangles / 160 clipped vertices
confirm the minimum clearance `0.01999992383354 m`. Heights are affine inside each
triangle, so this closes the between-sample geometric gap, not the GPU-depth gate.

The retained regression builds actual admitted terrain and floor geometry from
shared constants, requires the complete 644 m² footprint and at least 19 mm
clearance, and verifies that the fixture uses the actual final leaf size. The
floor-only correction uses one fixed negative depth unit with zero slope bias
on the arena/lobby/hospital material owners. Physical heights, geometry,
navigation, shadows, depth testing/writing and render order remain unchanged.
Three additional real-material/projection tests and the existing floor/stream
tests bring the final shared run to **286 tests / 31 files**, all passing.
All three typechecks and fresh shared/server builds pass after this correction.

**Probe11 rejects the proposed visual fix:** the one-unit material bias does not
remove the distant green stripes in the actual image. It remains a development
candidate, not a completed fix. The inner spatial study passes but cannot certify
these pixels. A real installed Three backend-key reproduction exposes omitted
polygon-offset fields in the pipeline cache; actual pipeline ownership remains
the next causal check. Do not increase bias blindly or mark the floor task done.

Probe11 ran 2026-09-10 20:41:02.650–20:43:08.868 UTC, with 37 successful HTTP
receipts, 22 spatial / six baseline PNGs, 125 unchanged pins and clean owned
browser/stack/port cleanup. Its outer run still fails on cow content and retains
14 dagger fit errors; page/GPU errors are zero. Twelve unique grass anchors have
528 repeated installed checks / 515 independent rays, zero recorded violations;
campus/pond-bank coverage is still zero. Floor geometry and transform receipts
match probe10 exactly. Bias values themselves are not in study06's live receipt;
the evidence is pinned source/material tests plus the failed pixel comparison.

| Probe11 receipt | SHA-256 |
| --- | --- |
| report.json | `228b78d95b744add8935ec86c0b19b56da40716dc45a65be6008a6868fb689cf` |
| spatial-study.json | `59ae12c55f84ba75367c56900ad54359a5dfe046d96a3cda12d74528f9a5ebdb` |
| launcher.log | `e7a19a5b6fd92cf65e9e8c537e939244def163f3256d0d3a1504c09c8235d04d` |
| Competitive build | `20f8dc0c48c1bfda631b60f78d94dcc66705e5202cb374f59874673626796de4` |

The user's subsequent review correctly rejects the overall terrain quality.
The [environment-art brief](compact-island-environment-art-brief.md) makes a
finished preparation scene the primary next deliverable; bounded technical
diagnostics continue alongside that work, not as a substitute for it.

| Probe10 receipt | SHA-256 |
| --- | --- |
| report.json | `169fe629278df3a3fc2eb44662e30934beffb4c59a90a7a027eae81b20fa0c69` |
| spatial-study.json | `604c3d8ae1ffe82b40637c7764f7ced22a7aca9ac9d75456acd7a908728f5523` |
| launcher.log | `340cf6101a0f04bfbce21e89af33dfd87cd057ffe80b5373c3a7bc8a2a6f51e8` |
| Competitive build | `ea3f081e2cbcc874692531fb372d760a251a5dc6aedf60513f90b8f88c9771e7` |
| World content identity | `86595106056a3dc8ddc87d4e4dfa499f8fb3422fd2a4b51c5fa36c0e457cadfc` |

Local images: `asset-studio/game-test-integration/compact-world-probe10/`,
including `spatial-island-wide-UNDER-OVERLAY-DIAGNOSTIC.png`,
`spatial-hub-UNDER-OVERLAY-DIAGNOSTIC.png` and
`spatial-pond-UNDER-OVERLAY-DIAGNOSTIC.png`. The under-overlay labels are diagnostic
captures, not proof that the normal broadcast UI is ready.

## Current acceptance work

- [x] Correct and regression-test material initialization order.
- [x] Rerun immutable study06 in a new evidence directory without weakening
  admission; confirm the actual client material and visual result.
- [x] Compare actual wide/hub/pond/campus-link views with probe08; record both
  improvements and regressions. No invisible arithmetic change is an art pass.
- [x] Record non-vacuous island-anchor evidence, computed/installed agreement and
  independent strict triangle-ray contact; retain empty regional coverage.
- [ ] Add appropriate preparation-campus and pond-bank ground cover, then qualify
  full blade/clump footprints and moving-camera/LOD behavior, not just anchors.
- [ ] Finish paths, convincing pond/ocean banks, ground dressing, terrain texture
  detail and coherent foliage/lighting. Check actual rendered and gameplay ground.
- [ ] Measure representative moving-agent CPU/GPU frame times, loading, memory
  and broadcast behavior. This intrusive static diagnostic does not run streaming,
  the betting keeper or the complete live preparation/duel loop.
- [ ] Resolve missing cow content, dagger metadata, cached-GLB lifecycle and the
  remaining avatar/equipment/launch checklist gates.
