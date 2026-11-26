# Authored grass surface checkpoint — 2026-09-10

Status: calculated-surface correctness checkpoint, **not a terrain art, rendered
contact, performance or launch pass**. The compact island remains visibly below
the requested quality bar. No deployment or main merge is included.

## Implementation

- Main-thread terrain and actual generated grass-worker code share ordered
  authored-grade, masked-zone, radial-pond and arena-floor calculations. Authored
  blends use the same raw procedural input; the ordinary shoreline fallback
  remains separate. Grass height and its 0.5 m normal stencil use this final
  calculated surface.
- Validated, detached regional snapshots retain mask Sets, zone ordering, owned
  floor identities and elevated water bodies. Query and snapshot work is bounded;
  malformed batches are rejected before dispatching an earlier subset.
- Grass exclusion is independent of terrain shaping. Assets commit
  `c130b5065c026470fc612225189ec46073ae1f97` adds only `excludeGrass: false` to
  `preparation_campus_grade` and `haven_pond_floor`. Station, plaza and arena
  exclusions remain; elevated water retains 0.1 m clearance.
- Immutable request ownership prevents late/stale results from replacing newer
  chunks. Live terrain-leaf membership allows grass to regenerate after a camera
  exits and returns within the grass horizon without another terrain-load event.
- Density, range, LOD and GPU-upload budgets are unchanged. Combined initial/LOD
  worker dispatch is additionally limited per frame (one stream, two default).

## Verification

- 189 focused shared tests across 20 files pass, including real generated workers,
  regional snapshot integration, terrain/quadtree out-and-back and GLB cloning.
  This total includes overlapping helper suites; earlier subset totals are not
  additional unique coverage.
- 273 server regression tests across nine files and 13 launch-validator tests
  pass. The source-based preparation topology check covers 59 targets, with a
  maximum modeled 30-tile route / 5.4 seconds of running; it is not live-agent
  transaction or duel-cycle evidence.
- Shared/client/server TypeScript checks, fresh shared/server builds, scoped
  lint/format/diff checks and eight immutable study05 tests pass.

## Actual WebGPU evidence: compact-world-probe08

Local evidence is in `asset-studio/game-test-integration/compact-world-probe08/`
under the parent workspace. It is retained separately from source Git; these
links/hashes do not mean the large capture directory is backed up on GitHub.

- Ran 2026-09-10 19:42:19.078–19:44:27.257 UTC. Actual Chrome/Metal/WebGPU,
  1280×720, DPR 1; 11 views / 22 spatial PNGs plus six baseline PNGs. The diagnostic
  retained 36 custody receipts; it does not run the actual betting/keeper/stream.
- Inner spatial study passes; **outer run fails** on the missing cow model (404
  and five unexpected console errors). Fourteen retained canonical dagger
  missing-fit-metadata errors remain release blockers. Page/GPU errors are zero.
- 44 repeated before/after observations inspect six resident grass instances,
  264 repeated anchors total, not 264 unique plants or whole-island coverage.
  Maximum calculated-height error is `9.276353232223755e-7 m`; maximum normal
  component error is `1.1107145873184843e-7`. No recorded height, normal, water,
  exclusion or invalid-instance violations occur.
- **Rendered contact is not qualified:** 264 repeated anchor ray samples have no
  missing hits but 44 gaps beyond the 0.05 m diagnostic threshold; maximum
  absolute gap is `0.0742489802187265 m`. One unique failing anchor is repeated
  across those 44 observations. These are retained CPU terrain triangles,
  not every blade's foot, GPU wind geometry or proof of pixel visibility.
- The intrusive observer is not a representative frame-time benchmark. Passing
  computed agreement is not adequate grass density or visual acceptance.
- Camera/render state restores, the owned browser closes, PostgreSQL exits and
  ports 3333/5555/57831/9236 are free. Cleanup errors are empty and all 115 pinned
  source/build/asset files remain unchanged. Earlier failed runs remain failures.

| Receipt | SHA-256 |
| --- | --- |
| report.json | `72d1a1f8514f5b18ce1bf4d27f1fb13df39875076d7ccdd220452eca8066d2e9` |
| spatial-study.json | `0059178915c490b83e26626cf2e2805cbc51daf635c0884d7291923c7b5cb65b` |
| launcher.log | `7e006955f6a1454bbb59082664aadffe8dca203de8cbb46191b68ed74818be83` |
| Competitive build | `dc4fc55152f9b94dc7e8192e6353e89802812ff6119c55da6feb104789684d23` |
| World content identity | `28d3958fde67f772e1dbf5c050293948f9734bdeee3461568fd77f4631819f1c` |

## Next quality work

- [ ] Resolve grass/actual rendered-surface contact without increasing unbounded
  per-frame work; qualify moving cameras, LOD changes, shores and blade bases.
- [ ] Replace the abrupt snow/canyon/forest blockout and excessive grade cuts
  with one coherent compact island, connected paths, believable banks and useful
  preparation/arena sightlines. Existing noise modulation is not hydraulic
  erosion; more noise alone is not an art direction.
- [ ] Improve ground-material layering, normal/roughness detail, tree rendering,
  ground cover, water/shore transitions and consistent day/night lighting.
- [ ] Retain matched visual review and measure representative CPU/GPU frame time,
  loading and memory with real actors and activities. Do not hide quality cuts.
- [ ] Resolve missing cow content, dagger metadata and the separately recorded
  [GLB actor-lifecycle audit](glb-actor-lifecycle-audit-20260910.md).

The recommended art workflow combines authored large-scale landforms with
procedural detail/placement, baking expensive static work when useful. Artist
control and procedural efficiency are compatible; see Guerrilla's primary
[procedural-placement presentation](https://www.guerrilla-games.com/read/gpu-based-procedural-placement-in-horizon-zero-dawn).
That reference is direction, not evidence that Hyperia already meets its quality.
