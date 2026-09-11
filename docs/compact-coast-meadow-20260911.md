# Natural coast and meadow refinement — engine checkpoint, 2026-09-11

The preceding vegetation checkpoint is pushed as
`2bc7c5a8989840907e4ea42f6b4f3dcced694be8`. Remote HEAD, GitHub author and
committer `dreaminglucid`, and all 20 committed source/test blobs against probe47
are verified. Probe47's spatial study passes; its entire run still fails the
19 inherited cow/dagger errors. The actual engine images remain well below the
target. The generated concept is an art-direction reference, not engine output.

## Grass appearance candidate

Probe47's bank image shows very fine, bright grass against broad terrain. The
actual GrassVisualManager—not the separate legacy procgen grass shader—uses
0.45–1.15 m nominal heights, height×0.04 width, a 0.18 arc ratio and 1.4 tip
brightness. This is source evidence for the proposed change, not proof that
these are the only visual causes. Sky/lighting and terrain material agreement
remain separate open work.

Only the explicit compact-island capture profile receives
`compact-meadow-v1`: nominal height range 0.25–0.65 m, width ratio 0.1, arc
ratio 0.32, root brightness 0.72 and tip brightness 1.02. Existing deterministic
per-blade variation is retained; nominal height ranges are not hard maximum
world bounds. Wind displacement uses the candidate nominal maximum height.
The material still receives the existing terrain palette and shade response;
the root darkening is an art approximation, not computed ambient occlusion.

Ordinary gameplay and fixed-arena grass retain their prior shape/color behavior.
No placement RNG, instance count, density, eligibility, range, upload budget,
LOD topology, texture input or render pass is added. Wider blades change pixel
coverage: equal triangle and buffer counts do not establish equal GPU cost or
better antialiasing. Require actual motion review before approval.

Three real-construction CPU tests pass. They check ordinary/fixed equality,
deterministic candidate buffers, unchanged topology/UVs/normals/root centers
at all three LODs, finite nondegenerate triangles, reduced height and width
ratio, 60 vertices/36 triangles per candidate LOD1 clump, and opaque PBR
material/configuration. Scoped lint and format pass. These tests do not compile
WGSL, inspect pixels or qualify performance. Integrated builds now pass as
described below; probe48's live review is recorded below.

The geometry/readability and root-shading direction is informed by
[AMD's procedural grass discussion](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/).
Its mesh-shader implementation is not a WebGPU capability or a drop-in for this
game. This implementation retains the existing instanced geometry and
[Three.js node material](https://threejs.org/docs/pages/MeshStandardNodeMaterial.html)
path. No AMD code is copied.

## Integrated source qualification

The frozen slice contains 18 TypeScript source/test files and the exact
`world-config.json` v4 descriptor. Root's integrated run passes **449 unique
tests across 37 files**: shared 332/33, client streaming 35/2 and server 82/2.
All three normal builds/typechecks and scoped lint pass. Server build identity
is `12c3688c1b84cb52b07818aab79c7633b5155caf47eeec7f95ff3fcc31be46bd`.
An independent source review found no blocker in the grass appearance diff.

The bay uses algorithm `compact-island-sculpt-v3`, profile
`compact-duel-island-v4`: a rounded elliptical inner cap, a gently bending
centerline and unequal bank transitions. Four explicit admitted fields are
innerHalfWidth 24, centerlineBend 8, leftBankScale 0.95 and rightBankScale 1.1.
The same ten 64-resolution coastal leaves retain 84,420 triangles / 3,450,160
geometry bytes. Against 102,010 CPU height samples, maximum approximation error
is 0.265756 m and near-water maximum is 0.135885 m. These are not exact
heightfield/rendered-mesh identity or live contact approval. The two 128-resolution
pond leaves, all 13 tree transforms, authored grades and paths remain unchanged.

Restored dry land increases grass under the unchanged eligibility/spacing rules.
The six actual-worker leaf counts for v4 are 271, 503, 139, 532, 493 and 343:
**2,281 clumps / 82,116 nominal triangles**, up 151 / 5,436 from v3. The two changed
leaves add 22 and 129 clumps; campus count stays 143. The test separately executes
the real worker with the old-v3 fixture and preserves its 2,130 census. There is
no artificial exclusion to hide this new cost. Actual installed counts, pixel
coverage and GPU costs remain distinct: probe48 confirms the installed census,
but does not qualify GPU cost.

Resource authority now sends the initial snapshot directly through the exact
connecting socket, because the broadcast lookup map is not yet registered.
The real client connection starts a session overlay before terrain startup.
Ordered server booleans persist independently of tile residency; unknown local
trees remain pending, old async publication is cancelled on reconnect, and a
replacement snapshot retires only omitted locally owned actors. Borrowed
network-owned entities keep their ownership. No local respawn clock or larger
110m entity relevance radius is introduced. Fifteen real-class ordering cases
and a real binary WebSocket delivery regression pass. This does not replace
actual browser harvesting/depletion/reconnect testing.

## Actual Metal/WebGPU checkpoint: probe48

The exact frozen source was exercised on 2026-09-11, 20:28:12–20:31:22 UTC,
using runner31/study23 and the explicit `island-720p60-v1` profile. All 116
successor harness tests pass. The renderer is real, initialized, non-fallback
WebGPU at 1280×720, DPR1. No quality reduction or diagnostic light/clock override
was introduced. The world content identity is
`5637b7edea1f6302c2ca305d6e20e30091759f018907e50c1955d4d831291135`.

Spatial, presentation and island studies **PASS**. The entire run **FAILS** the
same 19 inherited errors: five missing-cow errors and 14 bronze-dagger
`missing_fit_metadata` errors. There are zero GPU/page errors; these content
failures remain launch blockers, not warnings waived by a passing spatial study.
The owned browser closed, launcher exited 0, all four owned ports were free,
and cleanup recorded no errors.

Root independently verified all 454 current source hashes, 385 archived files
(28,576,213 bytes), and all 39 original PNG hashes and 1280×720 dimensions.
Both independent tree censuses contain the same 13 expected IDs. Each has a
known server state and matching entity configuration; the current connection
owns the session token. The resource map correctly contains only the eight
locally registered procedural trees; five authored trees are network-owned.
This is point-in-time authority agreement, not a live harvest/reconnect test.
Both grass censuses contain 2,281 actual installed clumps.

Independent review also confirms all 67 geometry/art/lighting checks, unchanged
coastal/pond geometry budgets, all six `compact-meadow-v1` material owners, and
all 11 exact HUD restorations. Native adapter is Apple Metal3. The 16,801 sampled
grass-base CPU rays find no missing retained terrain support; maximum gap is
1.858e-6m. This is sampled CPU contact, not all-blade or GPU-pixel contact proof.

Preserved local evidence: `asset-studio/game-test-integration/compact-world-probe48`.

- `report.json` SHA256: `aba10d0f03df45d707873c6cc1004b85778ac7893c46cb6623496e77560d6337`.
- `spatial-study.json`: `ef4ef0fd2012d432cc321f0cf6ebe95204a944de2b278c120edc07753893931f`.
- `compact-presentation.json`: `c5f345da1665422dec4cc88917c2e168d46b4e6778cc198213c41fc30ab46c09`.
- Wide image: `a02f3a6668a54f13ee320aa8cc588ed852e649a1bd0babe0564122c4082e1d58`.
- Bank image: `230751798e8b81ab2822879bfbf5c65d323cf4ae851639529f02b3de12785017`.

Root inspected the unedited actual wide/bank images. The curved inlet is an
improvement over the squared cut and the meadow is less needle-like. It is
**not** target-quality art: the island remains empty, the shore uniformly gray,
ground cover pale, tree shadows hard/cyan, terrain repetition obvious, and
stations lack coherent architecture. The amber diagnostic badge remains visible.
These are engine images, not the generated concept or decoded stream output.

Unedited copies: [wide v4](visual-review/compact-island-20260911/wide-engine-v4.png)
and [bank v4](visual-review/compact-island-20260911/bank-engine-v4.png). The previous
wide/bank files remain unchanged for reference.

RAF scheduling, not GPU time or FPS: cold startup spans 27.016s with p95 41.7ms,
p99 142.4ms and maximum 300.5ms. The two separate 10s windows have p95/p99/max
16.7/25.4/50.0ms post-equip and 9.2/17.3/42.2ms post-study. Camera motion and
day-phase differences prevent a controlled cross-run or before/after benchmark.
Do not infer a performance improvement from these values.

## Next prerequisite: material fidelity across loading paths

An independent actual-class CPU reproduction found that ModelCache's current
processed persistence is not equivalent to the cold scene. A three-mesh fixture
with shared ARM becomes three materials/one texture cold, then three materials/
nine texture objects on reconstruction. Samplers, mip policy, UV1/UV transforms
and environment intensity are lost. These are object/state observations, not
measured GPU allocations. Cold conversion separately discards physical-material
properties and forces metalness to zero despite the current environment lighting.

Repair static persistence with versioned exact-byte provenance, identity tables,
faithful supported material/texture/geometry state and safe rejection of
unsupported scenes. Verify genuine browser IndexedDB cold/warm rendering before
claiming parity. Then qualify cold conversion/sharing and physical-material
policy as separate changes; do not silently combine them with terrain tuning.
The [texture contract](https://threejs.org/docs/pages/Texture.html) distinguishes
UV channels, sampling and shared pixel sources; the
[physical node material](https://threejs.org/docs/pages/MeshPhysicalNodeMaterial.html)
supports the physical properties currently being discarded.

The isolated CC0 cliff05 package is a provisional stronger normal-bake candidate,
not installed: 19,999/6,000/1,499 triangles, three shared 2K maps. Its approximate
64MiB decoded full-mip estimate is asset-level only. Two boundary-adjacent sampled
projection misses and worse worst-case seam error remain disclosed in its
assessment. Placement, cold/warm materials, actual LOD transitions, playable
clearance and native GPU costs must be qualified before promotion.

## Parallel live and asset gates still open

- Rounded, tapered inlet with a gently bent centerline and unequal banks,
  strictly versioned descriptor and the same admitted coastal refinement envelope.
  Preserve arena/campus/pond/roads, all functional resource identities and
  native-worker agreement. Integrated regressions pass; actual engine art review
  confirms the intended curved form; broader coast art acceptance remains open.
- Direct owned-socket initial resource snapshots plus retained client-session
  resource state. Missing authority must remain pending, not a full or falsely
  depleted tree. Verify snapshot ordering, absent entities, stale async creation,
  tile unload/reload and reconnect in the live game. The source repair is tested;
  the complete behavior is not certified by a static tree census.
- Isolated preparation of [Poly Haven Coastal Cliff 02](https://polyhaven.com/a/coastal_cliff_02)
  under its [CC0 asset license](https://polyhaven.com/license). Preserve originals
  and provenance, derive bounded LODs, verify packed maps/AO/UVs/normals and
  compare identical-lighting renders before game installation. This is a cliff
  facade, not a closed boulder or a suitable high-resolution gameplay collider.

No canonical cliff asset or new global render default is promoted by this pass.
Final visual acceptance, GPU/frame tails, sustained thermal/minimum hardware,
functional resource motion/lifecycle, sound and decoded-stream qualification
remain open. Preserve failed captures and report content errors independently.
