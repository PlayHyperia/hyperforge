# Richer compact meadow: grounding prerequisite

Status: CPU experiments only. Neither the denser placement nor larger blades
have been installed. Runtime grass remains the native52 configuration.

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

| Six resident leaves | Current | Denser, original geometry | Denser + conservative filter |
| --- | ---: | ---: | ---: |
| Clumps | 2,281 | 4,019 | 2,437 |
| Nominal triangles | 82,116 | 144,684 | 87,732 |
| Installed attribute bytes | 291,968 | 514,432 | 311,936 |
| Campus clumps | 143 | 280 | 248 |
| Maximum chunk draws | 6 | 6 | 6 |

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
and two scalar loads per vertex, not free GPU work.

Endpoint correction still needs a complete base-edge check across terrain
creases and conservative exclusion/wind/culling bounds. Exact retained neighbor
identities must govern retirement/requeue. No storage/shader change has been
implemented by this design note.

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
