# Richer compact meadow: grounding prerequisite

Status: CPU experiments only. Neither the denser placement nor larger blades
have been installed. Runtime grass remains the native52 configuration.

## Per-blade correction prototype (not installed)

`GrassBladeGrounding` now computes two exact world-Y endpoint corrections per
blade, then checks the complete corrected base edge against actual retained
terrain triangles. It preserves accepted input order, all five attribute arrays
and worker RNG. It returns each exact neighboring surface used by endpoint,
edge or full fade/wind-envelope checks; no live ownership tracking is implied.
Missing/overlapping support and exhausted work cannot publish partial arrays.

Two dense production-worker leaves were measured after actual retained-surface
projection, without changing the existing blade geometry:

| Leaf center | Input → retained clumps | Rejections                    | Triangle visits | Extra correction bytes |
| ----------- | ----------------------: | ----------------------------- | --------------: | ---------------------: |
| 450,350     |               478 → 458 | 20 swept-pad                  |          11,574 |                 43,968 |
| 350,250     |               600 → 588 | 11 swept-pad, 1 discontinuity |          15,454 |                 56,448 |

Maximum accepted base error is 5.876mm / 5.731mm in those leaves. The known
0.187375m extended-plane gap is corrected. The 0.567480m mixed-LOD example
still crosses an actual discontinuity after endpoint correction (about 0.316m
full-edge error), so the clump is rejected rather than falsely certified.
This establishes base-edge support, not tip/terrain clearance or GPU execution.

Exact Float32-axis bounds reduce triangle visits from 93,410 / 131,544, but
measured complete CPU calls still take approximately 23–40ms per leaf across
the observed runs. Fewer visits are not a demonstrated frame-time improvement.
Do not call this synchronously in a 60Hz installation frame. Next integration
must provide bounded continuation or off-thread work, preserve all neighbor
revisions through publication, and qualify actual shader buffer ownership/cost.
`work_budget` is explicitly not resumable: retrying identical input cannot make
progress. No density, shader, render-pass or live grass-manager change is enabled.

Tests cover actual synchronous/worker prefix equality, LOD0/1/2 and fade values,
mixed-resolution neighbors, malformed inputs/topology, exact triangle-boundary
coverage and conservative road/pad/water envelopes. These are CPU correctness
gates, not visual or sustained-performance acceptance.
Peer review also found finite-but-overflowing road coordinates could create
NaN distances and bypass exclusion. Admission and derived projection/distance
checks now fail closed, with three overflow cases and an ordinary intersecting
road regression. The focused prototype/unchanged terrain suite passes 20/20;
the final combined shared regression passes 776/776 in 57 files.

## What the actual worker experiments found

The first proposal reduced spacing from 2.8m to 2.1m and enlarged the existing
blade profile. Actual output rose from 2,281 to 4,019 clumps across the six
resident leaves. The enlarged shape exceeded its previous envelope and worsened
contact risks; it is not approved.

A second experiment kept the original geometry exactly and changed spacing
only. All five raw and projected attribute arrays preserve the original
accepted prefix; the increase adds 1,738 clumps without rerolling existing ones.
But geometry is grounded to one retained triangle's extended tangent plane
per clump. Individual roots crossing triangle or LOD edges can float or clip.
The original prefix already has these defects. The complete second experiment
measured 96,456 candidate blade-base vertices using ten actual generated retained
surfaces matching native52's archived topology; the worst new LOD-edge gap
reaches 0.567m. The earlier six-surface experiment explicitly had unmeasured
outer roots and is not complete contact evidence.

| Six resident leaves       | Current | Denser, original geometry | Denser + conservative filter |
| ------------------------- | ------: | ------------------------: | ---------------------------: |
| Clumps                    |   2,281 |                     4,019 |                        2,437 |
| Nominal triangles         |  82,116 |                   144,684 |                       87,732 |
| Installed attribute bytes | 291,968 |                   514,432 |                      311,936 |
| Campus clumps             |     143 |                       280 |                          248 |
| Maximum chunk draws       |       6 |                         6 |                            6 |

The external removal-only filter encloses the full fade/wind shape against
authored pads, road capsules and water bounds. It clips the complete root
rectangle against retained triangles and requires at most 2cm tangent-plane
error. Missing coverage cannot pass. Survivors show zero measured root
pad/path/water intrusions and errors within −0.019805 to +0.019443m.
This tolerance is a feasibility parameter, not a rendered contact certificate.

After that correction the meadow is only 6.84% fuller overall, although the
campus is 73.4% fuller. That is not the substantial island-wide transformation
being sought. Per-blade terrain conformance is the next implementation question;
raising density alone does not fix the actual problem.

## Runtime design constraints

Worker and synchronous paths already converge on `projectGrassAnchors()`.
Grounding/exclusion correction belongs after acceptance, without altering
worker RNG. A proper implementation must track every retained surface it uses:
neighbor replacement, overlap, missing support and LOD changes must retire or
requeue dependent grass. An incomplete neighbor must not produce a permanently
completed empty chunk.

Compare bounded per-blade root corrections against retained-height sampling,
including vertex attribute/storage limits, extra bytes/fetches, complete root
edges, fade/wind bounds, shader normals and install-time cost. Preserve the
existing worker pacing, instancing, resource-tree ownership and renderer profile.
No extra-density or frame-rate claim can be made before actual native motion
and sustained timing tests.

The preferred next prototype computes two world-Y corrections per blade, one
for each base endpoint, and interpolates them across the blade after its current
scale/rotation/tilt. Root corrections must not disappear with the height fade.
For active LOD1 this is 24 float32 values / 96 bytes per clump: 385,824 bytes
at the 4,019 raw-candidate count, plus GPU storage. A single read-only vertex
storage buffer avoids exhausting portable vertex attribute limits when the
renderer switches instance matrices to attribute storage. It adds a binding
and one vec2 read per vertex, not free GPU work. LOD0/1/2 correction storage is
192/96/32 bytes per clump respectively; the final retained population is still
unmeasured.

Endpoint correction still needs a complete base-edge check across terrain
creases and conservative exclusion/wind/culling bounds. Exact retained neighbor
identities must govern retirement/requeue. No storage/shader change has been
implemented by this design note.

The current grass material is shared. A proposed per-chunk correction buffer
must have an explicit per-chunk position node/material owner while borrowing
the existing lighting/fade uniform nodes; switching a shared storage binding
between draws without proving refresh is not acceptable. The current material
factory overwrites manager-held uniform references, so it cannot simply be
called once per chunk. Every retirement/LOD/reconcile path must dispose the
new buffer/material along with geometry. Shader/pipeline sharing, actual
compiled binding limits and all lifetime transitions require native tests.

## Evidence

External directory:
`asset-studio/game-test-integration/grass-meadow-preflight02`.

- Original candidate `report02.json`:
  `d11fe1d1850a18af094af8572b097a84c948bb037e4245d0ae0247027ceacb57`.
- Density/contact `report03.json`:
  `1fc610d66e6e1abc9ef547c3ddb0514d9346947bb96bd8be83fe4bd10d49cce7`.
- `census03.mjs`:
  `e7dede7dffb5f32ee8fb9f55968119d1675b581fdd3ff902d3a5d97ca8d60fbb`.
- `envelope03.mjs`:
  `4ea63286b5e9112385ea03dd376a4c9a0ca2a3bb3c780bee746106f2552ffb14`.

Root independently verifies the report, all 16 named current source inputs and
the archived topology receipt, and reviews the clipping/envelope code against
the existing shader transforms. The experiment is not a complete transitive
execution archive, native render, shader evaluation or performance benchmark.
