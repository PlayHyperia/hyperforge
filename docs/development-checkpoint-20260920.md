# World graphics development checkpoint — 2026-09-20

## Fitted pond docks and terrain refinement — source-only checkpoint

The two-dock foundation is implemented and verified with actual World, terrain,
Three and native PhysX objects. The test placements remain (390,424.5), eastward,
and (433,415.5), westward, within the checked-in inland basin study. No canonical
manifest or running localhost scene has been changed. All LAYOUT-01–08 gates
remain open, especially complete fishing capacity and integrated visual quality.

### Completed in this checkpoint

- Strict immutable opt-in manifest admission binds exactly two distinct dock
  recipes to one actual explicit pond, including its live radius-squared datum.
  Exact cardinal 3×6m cores and 2m landward approaches own 24 movement tiles each.
- One retained half-metre triangle surface supplies deck/apron drawing, native
  collision and movement heights. Posts sample the actual bed; first/last feet
  are set back half a metre to keep caps off the sloping approach. Rails have
  matching visible segments and dual-tile movement walls, with open entrances
  and deliberate casting gaps.
- Refcounted walkable-deck leases preserve underlying terrain, occupancy and
  other owners. Compact dock terrain rebakes sample canonical ground instead
  of the active deck. Atomic failure unwinds both docks, physics actors, meshes,
  grass exclusions and leases. Reentrant scene disposal cannot resurrect a dock.
  Client registration no longer treats walkable decks as optional scenery.
- The earlier three art03 coarse-assembly failures are resolved. The ownership
  fixture now uses production local-detail regions; mirrored-only refinement
  no longer projects an impossible coarse neighbour into distant terrain.
  Direct ring intersections still reject oversized detail, existing limits are
  unchanged, and fine seam geometry hashes remain identical to their goldens.

### Retained verification

- `dock-admission-tests01`: 52 manifest/DataManager tests, including mandatory
  water binding even when optional data validation is skipped.
- `dock-collision-tests02`: 172 actual collision/footprint/BFS cases.
- `dock-layout-setback-stock01` and `dock-layout-setback-art03-01`: 5/5 each.
  Two actual terrain placements, 3,250 Three rays with exact retained-height
  agreement, +Y triangles, 48 deck tiles, real support depths and all 64 support
  cap corners inside the flat platforms (minimum 0.13m margin).
- `dock-owner-native-tests02` and `dock-owner-native-tests03`: 11/11 each on
  stock and art03 assets. 86 merged-mesh/native ray checks, including front-cap
  approach probes; maximum native Y error 0.000001430511474609375m under the
  unchanged eight-Float32-ULP gate. Actual BFS, two rollback/retry failure modes,
  missing owners, registry mismatch, rebake/removal and scene disposal pass.
- Landing geometry: 967 vertices/792 triangles; jetty: 1,159/936. Two native
  actors/shapes, two merged meshes and one shared material. These are source
  geometry counts, not measured WebGPU draw/frame budgets or material approval.
- `refinement-art03-final01`: 150/150; `refinement-stock-final01`: 149 pass,
  one existing candidate-only skip. The art03 assembly fixture totals 153,050
  vertices/301,008 triangles including skirts, compared with stock 90,084/175,990.
  This added detail is explicitly **not** a production performance acceptance.
- `dock-owner-types-final01`: 718 roots including every new test, zero
  diagnostics and stable input hashes. `dock-infrastructure-regressions01`
  executed three real suites/13 cases; two nonexistent requested filters matched
  nothing and are not counted as coverage.
- `dock-protected01`: all 145 protected compiled artifacts and recovered
  lockfile unchanged. Localhost3333 returned HTTP200; the human client/server
  and database VM remained running. No installs, build replacement, database
  mutation or additional browser tabs were involved.

Earlier unsuccessful fixture probes remain in the local evidence history.
A negative test originally relied on which outer-grade guard fired first; it
now uses a real small terrain mutation to establish the intended clipping or
overdeep-post failure, independently of stock/art03 surroundings.

### Art, integration and performance still required

The current dock deck is a top surface, with inherited procedural wood bands,
not finished plank thickness, grain detail or approved dock art. Side structural
members extend beyond the walkable deck rectangle; it is not a full collider
bounding box. Full-world resource/station spawners can run after dock startup,
so the initial overlap check is not proof against later spawned obstructions.
Server startup still creates bounded mesh/material objects; no server GPU work
was measured or inferred. These limitations remain explicit before activation.

Next: integrate the relocated basin, habitat/contact data, all seven fishing
families/12 fish, tool/bait/feather supplier and bank routes into one isolated,
matched candidate. Then finish both dock silhouettes/materials and verify actual
gathering concurrency, walking, rendered/indexed/PhysX contact, day/stream views,
startup, frame time and memory. Source tests alone do not satisfy these gates.
Indexed geometry and explicit ownership follow the official
[Three.js BufferGeometry guidance](https://threejs.org/docs/pages/BufferGeometry.html);
that reference does not establish AAA visual quality.


## Inland pond/fishing source checkpoint — not layout promotion

The full-progression requirement is now part of LAYOUT-07 in all eight mirrored
planning documents: seven fishing families, 12 fish, tool/bait/feather supply,
a target of two accessible positions per family, shore access for every tier,
and two distinct, bounded procedural docks. Actual concurrent use and complete
bank/supplier routes remain mandatory acceptance gates.

### Implemented and measured

- Compact elevated water uses one static indexed mesh per basin, clipped to the
  sampled canonical terrain instead of a circular fan. True horizontal distance
  to the emitted shoreline includes dry islands and disconnected components.
  Ground sampling is separate from ocean staging and bypasses deck/cache
  overrides; existing ocean sampling and noncompact circle behavior remain.
- Fixed 0.5m pitch, radius at most 32m, at most 16,641 ground queries and 65,536
  triangles per basin are admission caps, not accepted frame-time budgets.
  No per-frame basin sampling was added. Constructor rollback disposes only
  newly owned geometry and preserves borrowed materials/containers/children.
- A checked-in **test-only design candidate**, not a runtime manifest, is
  `packages/shared/src/systems/shared/world/__fixtures__/inland-pond-basin-candidate.json`.
  Its SHA-256 is
  `62bf40a5ce72aae3ff5105b2403c67351600b121b1e24f0a0cc19be28427556f`.
  The preferred basin center is (410,415), with water Y24.6 and a conservative
  27m water envelope. Four unequal bank sectors form a higher northwest bank,
  eastern cove, southern shelf and southwest arrival bay. The grading envelope
  is 33m; it was reduced from the first study's 35m to avoid the existing lobby
  floor corner. Exact rendered floor/contact clearance is still unverified.
- In the art03 authored CPU field, 720 radial shoreline samples span
  X390.575–432.543/Z397.334–433.883, about 42 × 37m, with a 119.067m perimeter.
  Minimum sampled dry height at the 27m envelope is 1.015m above pond water.
  These do not establish navigation, actual indexed terrain or visual approval.
- Final stock CPU setup observations: current 7.5m body 703 vertices/1,224
  triangles/920 queries; 27m candidate 4,786/9,062/9,937; 32m capacity fixture
  8,574/16,458/13,796. Candidate setup was about 22ms in one run, not a frame SLO
  or benchmark. The art03 current pond has different authored banks and yielded
  715 vertices/1,242 triangles; those measurements are kept separate.

### Verification and retained failures

- `water-basin-tests04`: **17/17**, stock assets with no candidate environment
  override; the committed candidate is exercised by default, not skipped in CI.
  Real World/TerrainSystem/WaterSystem/Three objects, independent boundary
  distance oracle, exact-height contour cases, island/separate-pool coverage,
  radius caps, ocean/basin sampler separation and atomic rollback are covered.
- `inland-water-regressions02`: **102/102** across eight stock source suites
  covering conforming ownership, ocean continuation/grid/edges, manifest water,
  lifecycle, radial-profile admission and grading.
- The same regression selection with the separate art03 overlay
  (`inland-water-regressions01`) is **99/102**: three coarse resolution-2 terrain
  assemblies reject annular refinement above the existing axis cap, before
  water publication. No cap was relaxed. This profile/fixture combination and
  integrated candidate coarse-LOD behavior remain open for qualification.
- `inland-basin-source-types03`: 711 source roots including the edited tests,
  zero diagnostics and stable hashes. Earlier types01 caught two missing
  test-body sourceType fields; corrected, not suppressed.
- Focused run02 retained one failing exact-contour ray assertion: its test ray
  lay on the actual shoreline rather than inside the dry strip. The corrected
  case separately checks the dry interior and zero-distance boundary; runtime
  geometry/tolerances were not changed to hide that failure.
- Source lint and scoped diff checks pass. All 145 protected compiled artifacts
  still match the art03 report; original recovered lock hash is unchanged.
  No dependency install, live build replacement, browser launch, database
  mutation, runtime pond relocation or canonical-asset promotion occurred.
  Native WebGPU appearance, PhysX/indexed agreement, gameplay and target-device
  frame/loading/memory qualification remain open.

Local receipts: `asset-studio/game-test-integration/service-layout-network01-UNQUALIFIED/`.
The committed source/fixture and this narrative are durable; local measurement
logs, sampling scripts and captures are not represented as GitHub artifacts.

### Next integrated slice and dock audit

1. Rebind old coordinate-specific terrain contacts and explicitly admit a larger
   planted habitat; move terrain, water, fishing, supplier and approach data
   together. Remove the old pond/spot placement only in that matched candidate.
2. Replace dynamic-list-only fishing coverage with verified full-family targets,
   supply availability, concurrent gathering reservations and short bank routes.
3. Reuse the existing dock generator but first fix its elevated-water owner:
   it currently assumes ocean water, a fixed 3m bed, reversed north/south bearing,
   and rails whose collision exists without visible rail geometry. Admit exact
   cardinal tile-aligned 3×6m candidates, sample actual post bottoms and author
   entry/rail openings once for both drawing and collision.
4. Give docks transactional shared deck/height/collision ownership, a real
   destroy lifecycle and removal/rebake tests. Existing dispose is not called
   by World.destroy, and client registration is scenery-gated. Ordinary terrain
   rebakes preserve nonterrain flags; this is not a claim that every rebake loses
   rails. Physics support, grass exclusion and restart readiness need real tests.
5. Run a matched isolated native Chrome/Metal candidate: walking, all fishing
   tiers, two docks, multi-agent approaches, close/overview/stream views and
   measured rendering/setup costs. No proposed placement is approved by this
   source checkpoint.

Reference review continued with the official
[Three.js WebGPU water source](https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/webgpu_water.html)
and [BufferGeometry documentation](https://threejs.org/docs/pages/BufferGeometry.html).
Indexed static geometry and bounded shared materials inform this implementation;
the water demo's full render pipeline and screen-resolution costs were not
copied wholesale or treated as an island performance guarantee.


This is a work-in-progress source backup on `codex/sol-duel-stream-launch`,
not a release, merge recommendation, completed MVP or AAA-quality certification.
World art remains the priority: one compact island, open service pavilions,
one procedural arena, coherent live resources, and bounded WebGPU effects.

## Checkpoint policy

At each coherent, verified implementation slice, review the exact diff, run
relevant tests, check formatting/types and secrets, then commit and push to the
existing feature branch. Also checkpoint before a substantial new subsystem or
ending an extended work session. Do not accumulate another multi-day backlog.
Small later commits should identify their subsystem and retained evidence.

Use the user's configured `dreaminglucid` author and committer identity. Verify
the remote branch SHA after pushing. Commit related runtime assets separately
on their existing asset branch and record the paired revision. Do not merge,
deploy, promote experimental defaults, include real credentials or push local
databases, dependencies, captures, numbered conflict copies or recovery files.
An unresolved visual/performance gate stays open even when its source is saved.

## Repositories and scope

- Application identity fix: `3f5c36601d139e94a52746e4c84386fcc6d1a284`,
  already pushed and GitHub author/committer verified.
- Paired assets: `PlayHyperia/assets`, branch `codex/duel-arena-launch-assets`,
  revision `1869ff1503a00c3eda74ea99e8b1161406ec8b05`, pushed with both LFS
  objects and GitHub author/committer verified. Only two new runtime files:
  - `terrain/textures/compact-pbr/ground-height.png`, SHA-256
    `f83da0f031244f046d72adf229723da5857d36a6cd5fc542d11db019a60bc06c`.
  - `vegetation/compact-pond-v1/pond_sorrel.glb`, SHA-256
    `2f887028b517ad2e6ea3c75665dc4790c59a0ae66ea41ff6185e5b5375777d22`.
- This integrated source checkpoint retains the coupled terrain, shoreline,
  grass grounding/ownership, water optics, bank pavilion, rendering diagnostics,
  cache fidelity, local-runtime tooling and regression work since September 14.
  Newly imported source/JSON files travel with their consumers. The exact
  historical grass-worker fixture is now inside Git instead of a sibling
  authoring folder; its original byte/hash assertions remain intact.
- Experimental world manifests are **not** promoted. The asset repository's
  unrelated deletions, PhysX changes, candidate animations and local backups
  remain unstaged. Six application permission-only differences, numbered
  duplicates and unrelated package-manager copies also remain local.
- Hyperbet is a separate repository and is not changed by this checkpoint.
  Editable Blender files and diagnostic media in the external art workspace
  are not backed up merely by pushing application source or runtime exports.

## Verification and honest limits

- Initial changed-shared-source regression: **1,788 passed, 3 failed,
  10 skipped** across 59 files. This failed receipt is retained.
  Two failures were stale test expectations after the bank's eight upper braces
  moved into the roof cutaway and the bounded polygon limit increased to 32.
  Corrected tests retain exact post/brace masks and now prove both the exact
  capacity and atomic rejection above it. Both affected suites pass **41/41**.
- The third failure was the real grass grounding job reaching its existing
  active-CPU limit under concurrent validation load. The isolated two-case
  worker/synchronous parity rerun passes **2/2** without changing production
  limits, replacing clocks or weakening assertions. This does not qualify
  target-hardware performance; the initial failure remains meaningful evidence.
- Shared production-source strict TypeScript passes without emitted files or
  incremental writes. The focused actual Vite/GLTFLoader identity test passes
  **1/1**; it is not a native-browser visual test.
- Stock client readiness/stats tests pass **37/37**. The initial six readiness
  failures were caused by an old compiled shared bundle lacking the new bank
  admission getter. A narrow test-only source graph now binds the collector,
  real World/DataManager and procgen recipe consistently. The production
  readiness gate was not weakened and the playable bundle was not rebuilt.
- Bank art02 procgen tests pass **12/12**; physical geometry bytes, roof/footing
  hashes and historical smithy outputs are unchanged. Only the eight brace
  visibility labels changed. Fresh native art/motion review remains outstanding.
- The relocated historical grass fixture passes its actual worker proof
  **1/1**, with original SHA and semantics intact.
- A real inherited-pipe shutdown fixture race was corrected using an IPC
  readiness handshake after the descendant installs its signal handler.
  The shutdown suite passes **27/27**, including five consecutive isolated
  runs of that case; production shutdown behavior is unchanged.
- Serialized script verification with the explicitly selected Bun 1.3.14:
  **90 passed, 0 failed, 2 evidence-dependent skips**. This covers launcher
  shutdown, asset-gate/world-config validation, diagnostic pond policy, GPU-probe
  contract checks, Tailwind source scope and procgen source-map packaging.
  Earlier runs without the pinned Bun failed 12 validator cases; those failed
  receipts remain preserved. No runtime version requirement was relaxed.
- Isolated direct Vite development lifecycle: **three loaded graph/HMR/shutdown
  cycles pass**. Three preview shutdown cycles also passed in the earlier run.
  The concurrent first dev run's dependency-optimizer HTTP 504 remains retained;
  the passing rerun is not a claim that the first attempt succeeded.
- Native movement bootstrap tests remain **unqualified in this checkpoint**:
  two require ports owned by the protected playable session and fail with
  `EADDRINUSE`. No running human service was stopped or reused to obtain a pass.
  Next tooling task: an explicitly validated all-or-none local port tuple,
  ephemeral test allocation, and actual native gameplay rerun. The current
  movement harness source is preserved as work in progress, not certified E2E.
- Formatting checks and staged diff checks pass. Scoped ESLint found two DOM
  type names without a namespace in an existing browser-test helper; qualifying
  them through `globalThis` removes both warnings without changing runtime code.
  Checksum-verified Gitleaks 8.30.1 found no secrets in the staged source or asset
  changes. The formatting-only hook was run as explicit checks rather than
  allowing `npx lint-staged` to temporarily hide the dirty live working tree.

Never combine overlapping run counts or describe filtered/evidence-dependent
cases as passed. No complete full-repository or production-launch pass is claimed.

The protected human client on localhost:3333 and server on 5555/5556 remain
running. Their compiled shared client/server hashes are unchanged. Full builds
were deliberately not written over those live outputs. The bank integration's
earlier isolated matched build and native Chrome/Metal views remain evidence
for that specific candidate, not for subsequently edited art or performance.

Local checkpoint receipts are in `/private/tmp/hyperia-checkpoint-20260920.U3UHVG/`;
bank/physical/native receipts remain in
`asset-studio/game-test-integration/bank-pavilion-integration01-UNQUALIFIED/`
and `bank-pavilion-art02-UNQUALIFIED/`. Temporary checkpoint logs are local,
not durable GitHub artifacts. The launch checklist and graphics reference
library retain the longer-lived qualification narrative.

All seven world-art acceptance tasks remain open. Shoreline accounting remains
**3 checked / 8 open**. Bank service dressing/ground integration, arena artistry,
whole-island composition, particle coverage, movement, streaming, transactional
banking and measured multi-agent performance still require their stated gates.

## Follow-up checkpoint — bank art03 and expanded island layout

The verified source slice adds post-mounted bank key signs and asymmetric
service wear. The admitted bank recipe is explicitly v2, with exact readiness
metrics updated together: 1,492 triangles / 247,200 bytes / three batches.
Historical smithy geometry and non-pavilion paths remain pinned. No runtime
asset is added; the paired asset revision above is unchanged. Candidate
`assets-v2` remains a local, non-promoted overlay, not a GitHub-backed manifest.

Verification: 13 geometry, 32 path, 35 visual/cutaway, 11 native-owner,
4 selected candidate-owner, 2 candidate-access and 37 client tests pass.
Counts overlap and must not be summed. Strict source typing, scoped lint and
eight isolated bundles pass; all 145 protected compiled artifacts stay exact.
The first access invocation skipped all cases without candidate opt-in; the
first client invocation matched no files. Correct invocations and failed
receipts are retained, not silently counted as passes.

Native01 timed out at startup before art evidence. Native02 passes the unchanged
gate and produces three real Chrome/Metal views with stable pins and complete
HUD leases. Signs/cutaway improve locally, but pavilion dressing, dark ground,
angular grass, whole-world composition, motion and performance remain open.
A 114.6 ms maximum grounding-slice receipt needs isolated pacing investigation;
it is not a controlled comparison or a proven cause of the earlier timeout.
Owned diagnostics and temporary database are cleaned; human localhost services
and database remain unchanged. The evidence is local, not committed media:
[art03 review](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/bank-pavilion-art03-UNQUALIFIED/README.md).

The launch checklist and art brief now require LAYOUT-01–08: a small pavilion
town, multiple functional banks, distinct mines, island-wide tiered resource
trees with rarer high tiers, skill-local quest NPCs, scattered rune altars,
a naturally shaped farther-inland pond, and integrated gameplay/art/performance
acceptance. These are all open, with the singular schema/path dependencies
recorded explicitly. No forbidden comparative brand is introduced.

## Follow-up checkpoint — bounded plural service ownership

Source-only foundation: a versioned `compactServiceCourts` layout supports up
to eight explicitly identified bank/smithy courts. Strict JSON admission rejects
unknown fields, duplicate bindings, overlapping roof envelopes, unsupported
rotations/grids and ambiguous primary banks. Every service binding is checked
against the actual station/NPC manifests before owners allocate resources;
startup cannot bypass this check through optional validation settings. The
current axis-aligned recipes are intentional, not arbitrary-rotation support.

Real test Worlds own three banks and a smithy: four native PhysX actors,
12 shapes and 16 independently released footing exclusions. Visual ownership
matches complete descriptors. Streaming bank readiness checks every admitted
bank, not just the primary; broken outlier physics or visuals fail it. Existing
primary paths stay byte-identical with additional stations and reordered court
records. New outlying paths and a finished placement graph are NOT authored.

The host/emitted-worker exclusion limit grows from 32 to 64 polygons, with
64 vertices per polygon unchanged. Eight courts plus 24 landscape exclusions
use at most 56 slots under the stated content budget. Full-cap cloning,
point/boundary queries and atomic over-cap rejection are tested. This is a
bounded admission limit, not measured GPU, loading or multi-agent performance.

A BankEntity open event/packet now names the actual runtime bank entity, not
its manifest alias. The new test uses a real World/BankEntity and checks event
identity only; it does not claim live socket delivery or ledger safety. Before
LAYOUT-02 can close, prove A-deposit/B-withdraw on the same authoritative ledger,
exact bank-session target/range/type and close revocation, concurrent/replayed
requests, restart/process-loss reconciliation, equipment transaction rollback
and agent discovery at every real bank. Existing custody authorities are not
rewritten or certified by this slice.

Post-recovery verification:

- 66 owner/visual/path cases across three suites.
- 41 surface-snapshot, 28 actual emitted-worker and one real bank-event case.
- 21 existing client readiness regressions.
- Strict source typing: 710 explicit/production roots, zero diagnostics, stable
  source hashes; separate client typing, scoped ESLint and Prettier also pass.
- All 145 protected procgen/shared/server artifacts retain their prior hashes.
  Localhost3333 responds HTTP200; its existing client/server/VM remain running.

The initial explicit typing command named a nonexistent worker-test path and
failed before checking; its corrected run exposed a structural method typing
mismatch, subsequently corrected and rechecked. The first worker command ran
only the 42 existing snapshot/event cases; a separate exact-path invocation
ran all 28 actual worker cases. Failed receipts remain retained. No new native
browser rendering, private build, whole-island route test, live banking round
trip, duration test or frame/memory acceptance is claimed. All eight layout
requirements and all seven world-art acceptance tasks remain OPEN.

### Verification incident and repair

A delegated test invocation improperly used unguarded `pnpm exec`. It
materialized dependencies, failed the root Node-version preinstall check,
replaced a preexisting untracked lockfile, and then mistakenly deleted that
file. This was disclosed immediately; it was not authorized cleanup.

The exact original 780,127-byte `pnpm-lock.yaml` was recovered from the earlier
verified workspace backup. SHA-256
`b5565add729a7d90dcf15c4a83f875b5cb76ebcff707eef74d78140b784122fc`
matches the pre-incident recovery inventory, and a byte comparison passes.
The lock remains untracked, as before; it was not regenerated or committed.

All 62 known root package links and 21 binary links were restored to recorded
Bun targets, including vendored r186 Three types. Replaced links/shims were
moved intact to local recovery evidence, not deleted. All restored targets
exist; scoped workspace links have no pnpm targets. Sixty-one backup package
manifests match resident targets byte-for-byte; the backup Husky manifest is
cloud-unavailable and was not hydrated. Its recorded link and resident target
were verified, not its unavailable backup bytes. Relevant verification above
was rerun after repair.

Residual pnpm cache/store/metadata and extra links remain untouched; no pristine
whole-dependency-tree restoration is claimed. The subtask also issued
`git fsck --lost-found`; neither the resolved common Git directory nor the
linked worktree Git directory contains a resulting lost-found directory.
No VM/debugger attachment, service restart, database mutation or dependency
install was used for repair. Local audit/mapping/repair receipts remain in
`asset-studio/game-test-integration/service-layout-network01-UNQUALIFIED/`;
they are not GitHub-backed runtime assets.
