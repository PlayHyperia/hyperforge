# Compact island environment art: next delivery slice

<a id="whole-shore-composition-contract-review67-not-implemented"></a>

## Whole-shore composition contract

Proposed in Review67; the shared opt-in schema/material/grass implementation is
now present in Review68. This is not shipped behavior, visual approval, a default
promotion, or another global soil-height adjustment. Art and performance gates
remain open; the original Review67 link anchor is retained for historical receipts.
The [generated shoreline concept](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review67-UNQUALIFIED/shoreline-concept.png)
is an art target, not native evidence. Its broader grass changes are not literal
scope: preserve existing trees, ocean, actors, navigation and the open south.

### One authored basin and one matching surface domain

Use the existing four-sector radial profile to compose unequal planted shelves,
short exposed cutbanks and dry turf shoulders. Retain one submerged-to-dry
crossing per bearing, the 7.5 m water disk at Y = 27.8, bed radius 5 m and 11 m effect
envelope. This owner supports rounded star-shaped banks, not overhangs or an
arbitrary re-entrant coastline. Preserve southern-sector data and all protected
southern heights/access by measurement: an unchanged SE row alone is not proof,
because overlapping northern sectors can contribute. Not every arc is fixed.

Implemented optional `radialPond.bankComposition` schema:
`{schemaVersion: 1, sectors: [{sectorIndex, surface}]}`, with at most four unique
indices referencing existing `bankSectors`. Surface is exactly `sedge-shelf`,
`cutbank` or `dry-turf`; absent entries keep historical material rules. Require
dense own-data arrays/rows, exact keys, valid integer indices and supported
literals. Geometry stays in existing sector fields, never duplicated in paint
ribbons. Existing bounds remain: inner radius > 5 m and < 9 m; inner height > 26.6
and <= 28.08; paired outer radius > inner and < 11 m; outer height >= inner and
<= 28.68; bearing [-pi,pi], half-width (0,pi/2], maximum four sectors. These numbers describe
this admitted pond; validators continue deriving limits from its profile.

### Minimal shared implementation contract

Extend `pondBlend` with one explicit opt-in `composition-v1` mode. Absent,
relief-v1, relief-contact-v1 and shore-contact-v1 keep their material equations;
a changed terrain profile still changes geometry in every mode. Do not silently
activate the rejected generic margin trial or change its recipe.
Add a frozen `pondBankField(zone, pond)` projection in the self-contained
`createCompactTerrainColorOperations` factory. It resolves composition indices
to admitted geometry/water data without a second height solver. Appearance and
support end at or before 10.5 m: the existing 7.5 m pond + 3 m material reach
already bounds water-snapshot/grounding dependencies. Terrain influence remains
11 m; do not enlarge physical water or silently omit active outer worker jobs.
Extend `macroField(profile, coastBlend, pondBlend, bankField?)`; only
composition-v1 attaches the field, with exact global startup-domain validation.

TerrainSystem supplies the registered zone/pond without macro-getter recursion.
This first candidate is restart-owned: reject source mutation after startup.
Snapshot/canonical equality and leases alone do not refresh cached macro fields
or the shader graph; atomic live shader/worker/sync replacement is out of scope.
Extend terrain.ts, RadialPondTerrainProfile and GrassTerrainSurfaceSnapshot
admission/copy/freezing plus canonical equality for the optional composition.
GrassWorker validates its existing snapshot before deriving the regional field.
Remote jobs without the pond remain neutral; a zone-only snapshot outside the
appearance domain is legitimate. GrassVisualManager may retain a detached
global descriptor; per-job data stays bound to snapshot/lease/result identity.

A generic CPU/TSL `bankComposition(input, math)` uses AuthoredTerrainSurface's
same warped radius and normalized angular-overlap algebra, not nearest-sector
classification. Include unmapped sectors in normalization; their contribution
retains historical material rules. Use actual height/slope, roads and existing
noise. Surface families derive extent from knots; any additional art controls
belong to one validated recipe, not Review67 coordinates or hidden thresholds.
TerrainShader/CompactTerrainMaterial use conserved soil/grass/rock reassignment
in one vector for albedo/roughness/normals/AO. CPU root color and grass support
consume the same decomposition. Keep original wetness, water level, road
coverage, texture resolution, physical scale, filtering and normal decoding.
No new texture fetches; extra bounded arithmetic still requires native costing.

### Grounding, budgets and acceptance

Compare historical/selected seeded roots on identical candidate terrain before
thinning, not Review66's different geometry; changed height/slope can change RNG
acceptance. Greener material cannot invent roots. Put root-bearing ground above
the strong-soil interval, and bridge to wet ground with grounded
plant crowns. Do not claim root count or exact root/pixel color stays unchanged.
CompactPondDressing recomposes existing habitat by actual shoreline bisection;
retain <= 40 pond / <= 64 combined instances and existing mesh/map/batch budgets.
The northern habitat's current 215–280-degree validation is a real boundary,
not permission to place arbitrary new plants elsewhere.

Stage one: approve the composed profile and shared-domain tests; retain 2 cm
canonical/indexed tolerance, native PhysX agreement, single-crossing water
coverage, all prop/root contact checks, 27 southern tiles and 1,300 routes.
Stage two: actual overview must distinguish unequal edge families and interrupt
the continuous collar; near/grazing and distance-return must show grounded
coverage without painted green gaps, repetition or temporal regressions.
Retain current grounding work caps and measure changed refinement/grass costs.
No AAA, full-world, performance or original texture-repetition gate closes from
the concept, CPU masks or one still. [Frostbite's terrain/undergrowth treatment](https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/chapter5-andersson-terrain-rendering-in-frostbite.pdf) supports shared distribution and sampled ground color, not independent masks.

## Texture-quality priority — shoreline repetition remains open

## Plural service foundation — source checkpoint, not layout acceptance

The opt-in `compactServiceCourts` contract now admits a bounded, ID-addressed
set of bank/smithy pavilions. Actual owners, physics, visual leases and streaming
readiness enumerate the same descriptors; a missing outlying bank fails bank
readiness even when the primary is healthy. Station/NPC bindings are mandatory,
and explicit primary-bank path selection preserves historical ground paint.
Grass exclusion capacity is bounded at 64 polygons; this is not a cost approval.

Post-recovery verification passes 66 owner/visual/path, 41 surface-snapshot,
28 actual emitted-worker, one bank-event identity and 21 client-regression
tests. Strict test-inclusive source typing, client typing and scoped lint/
formatting pass. No new native browser or multi-agent performance acceptance
is claimed. All 145 protected compiled artifacts remain unchanged.

**LAYOUT-01–08 remain open.** No new layout is promoted: outlying journey/path
design, shared-bank custody/retry/restart verification, natural inland pond,
mines, trees, quest NPCs, dispersed altars and whole-island art remain to be
implemented or qualified. Bank-event identity coverage is not a live network
deposit/withdrawal proof. See `development-checkpoint-20260920.md` and local
`service-layout-network01-UNQUALIFIED/` evidence for scope and recovery limits.

## Inland pond and fishing — source checkpoint, placement still open

The pond must support all seven fishing families and all 12 fish, with two
distinct dock designs and non-dock access for every tier (LAYOUT-07 below).
The checked-in, non-runtime basin study at (410,415) samples approximately
42 × 37 metres of water and 119 metres of irregular shoreline; these are CPU
terrain measurements, not approved fishing capacity or in-game visual evidence.
Compact elevated water now follows sampled canonical ground with a fixed 0.5m
mesh and real shore-distance data. Its 17 actual-class tests and 102 stock
water/terrain regressions pass; native appearance, indexed/PhysX agreement,
frame cost and the full relocated habitat remain unqualified. The three
art03 coarse-assembly failures are now resolved: tests use the production local
detail regions, and impossible mirrored-only remote annular refinement is
rejected without weakening direct-intersection geometry caps. Art03 passes
150/150 terrain/water cases; stock passes 149 with one candidate-only skip.
The opt-in dock foundation now shares fitted approach/deck triangles, sampled
support feet and authored rail openings across drawing and movement/physics.
Two CPU-tested placements fit the candidate basin; native integrated art,
fishing capacity, complete routes and frame cost remain open acceptance gates.
No pond, fishing spot, dock or supplier has been relocated in the live manifest.

### Grass matrix follow-up — correctness verified, performance still open

Both actual grass constructors now use privately owned, versioned matrix
storage. Placement, density, geometry, wind, grounding, shadows, culling,
resolution and the 30-second transition gate are unchanged. Four real-class
suites pass 112/112 tests; source-only 725-root typing, scoped lint and
formatting pass. Build06 preserves all 145 protected compiled artifacts.

The actual Apple Metal grass fixture passes exact ordinary/storage pixel
comparisons at both active LODs and two wind phases, including received
occluder shadows and a translated/rotated parent. It proves zero unchanged
matrix uploads, native binding limits and destruction of root, visibility and
matrix allocations. This is a correctness fixture, not approved meadow art.

Native09 confirms all 65 observed grounded chunks own the expected storage
matrix, but still fails the unchanged pond transition. Native10 also fails.
No FPS improvement or sustained performance acceptance is claimed. Native11
proves the timestamp attribution defect: all 1,290 observed framebuffer-copy
resumes overwrite another pass's query slots. Its observation is complete,
with no counter overflow; the view deadline still fails. Treat native10/11
per-pass durations as invalid for cost attribution, not as exclusive costs.
This diagnostic defect does not itself explain normal rendering performance.
Renderer-accounted texture
memory is about 2.04 GiB, requiring an actual owner/allocation census before
choosing further optimizations. Keep vegetation changes separately scoped.

LAYOUT-01–08 remain open. Candidate route/custody separation, concurrent fishing
and finished pond views are not approved. Receipts:
`inland-pond-integration01-UNQUALIFIED/grass-storage-native01/`,
`native09/`, `native10/`, `native11/`, and `isolated-build06-report.json`; CPU receipts
are `service-layout-network01-UNQUALIFIED/grass-storage-*`.

### Static color-texture reuse — verified memory saving, performance still open

Parsed static PBR VRMs now reuse an exact matching ImageBitmap color texture
within each source material. Per-instance materials remain independent.
Unknown/dynamic metadata, real texture-transform payloads, custom callbacks
and unequal texture state retain separate views. All material setup callbacks
finish before aliasing. The VRM loader's injected optional transform declaration
is allowed only when no actual transform payload exists; required transforms
still veto reuse. No texture is resized, no mip is removed, and no borrowed
texture or ImageBitmap is disposed by this optimization.

The final three-suite gate passes 53/53 tests; 726-root source typing, scoped
lint and formatting pass. Build09 produces eight isolated bundles from 973
inputs, preserving all 145 protected compiled artifacts. Actual Chrome/Metal
fixture04 proves exactly equal day/night/shadow pixels, native color allocations
2→1 at 2048² with 12 mips, independent sibling materials and safe sibling removal.
Ten negative browser cases cover unsafe state, dynamic metadata and setup order.
Initial fixture failures exposed the loader-injected declaration; those failed
receipts remain retained rather than being counted as passes.

Native15 records 310 creations/two destroys versus native14's 325/two, with
known live payload 1,811,188,226 versus 2,146,732,526 bytes: 335,544,300 bytes
(about 320 MiB) less. Six depth-format footprints remain unknown, and bounded
owner/node attribution overflows; these are not physical-residency measurements.
The matched 15 NPC/mob texture groups cover the same 35 character instances:
each pair becomes one native allocation, retaining both material slots and all
30 captured texture-state fields. Non-character live allocation descriptors
also match exactly. Cross-run ImageBitmap object IDs are not pixel hashes.
The unchanged 30-second pond transition still fails, with four grounding jobs
and one LOD swap in its final settling observation. No FPS improvement, final
pond art, full stream or concurrent-fishing acceptance is claimed.

All owned browsers and runtime07/08 disposable databases are closed; human
localhost and protected outputs remain unchanged. LAYOUT-01–08 remain open,
including fourteen simultaneous anglers, two distinct docks and shore access.
Evidence: `inland-pond-integration01-UNQUALIFIED/avatar-texture-native04/`,
`native15/`, `avatar-texture-census-comparison.json` and
`isolated-build09-report.json`. CPU receipts in
`service-layout-network01-UNQUALIFIED/` are `avatar-texture-tests03.log`,
`avatar-texture-types03.log`, `avatar-texture-lint03.log` and
`avatar-texture-format03.log`.

### Shared-budget grass handoff — native captures, not art acceptance

Native17 observed 34 empty completions taking separate frames despite pending
work. Their active slices totalled 11.8ms; the unused nominal allowance is an
upper bound, not a promised speedup. The manager now hands validated empty
completion to the next nearest job using the same absolute 2ms deadline and
remaining 8,192-operation allowance. Nonempty publication still stops the call;
failure, waiting and cancellation do not spin. No appearance or shader changed.

The source passes 189 tests (one opt-in diagnostic skipped), 727-root typing,
scoped lint and formatting. Fresh build10 leaves 145 protected artifacts intact.
Native18 captures all three views within the unchanged 30-second gate:
28.02s overview, 11.29s landing and 3.89s jetty. Its complete ledger records
1,278 manager calls, 125 completed jobs and eight same-budget handoffs, with
at most 8,192 aggregate operations and one nonempty publication per call.
All eight handoff calls measured at most 2ms, but a single-continuation call
reached 38.6ms. The deadline is cooperative, not a hard wall-time guarantee;
sustained smoothness and allocation/scheduling pauses remain open.

All three views contain 14 real fishing entities, two per family; this is not
fourteen concurrent anglers. Root visual review rejects final art acceptance:
the pond still reads too oval, banks too uniform and dock timber too repetitive.
Natural coves, varied habitat, stronger dock character, dry routes, custody,
actual concurrent fishing and the complete island composition still need work.
All LAYOUT-01–08 gates remain open. No human localhost/default promotion.

Evidence: `inland-pond-integration01-UNQUALIFIED/native16–18/`, including
`native18/grass-budget-ledger.json` and all three PNGs; CPU receipts are
`service-layout-network01-UNQUALIFIED/grass-empty-handoff-*`.
Native18 observers restored, inputs remained pinned and the owned browser closed.
The console retains 41 unattributed HTTP503 errors and five known missing-model
404/load errors; a clean observer receipt is not an error-free-runtime claim.
Private runtime10/11 and disposable databases are closed; human services,
database and protected outputs are unchanged.

### Native texture census — diagnosis before implementation

Native12 confirms that the pond's two depth captures surround an actual
depth-writing back-face draw. Removing a capture is not established as
pixel-equivalent. Native13 uses unique timestamp pairs for all actual passes:
29 sampled frames, no GPU errors and 87/87 diagnostic resources destroyed.
Overlapping vertex-to-fragment stage intervals still cannot be interpreted
as exclusive pass costs. The unchanged pond transition deadline fails.

The pre-boot native texture census observes 325 allocations and two explicit
destroys. Known live texel payload is 2,146,732,526 bytes, plus six unknown
depth-format footprints; this is not physical resident memory. Seventy-seven
2048-square full-mip textures account for 1,722,460,740 bytes. Native allocation
counters do not overflow, but bounded owner/node attribution does; do not
claim a complete owner graph.

Native14 proves 15 loaded NPC/mob base/emissive pairs share the same actual
ImageBitmap, with matching captured sampler/UV/upload state, but retain
30 separate native textures (about 640 MiB). An exact audit of all 17 present
manifest-referenced VRMs independently confirms duplicate embedded images
within each asset, with no cross-asset equality or declared animation/
expression/UV-mutation bindings. This identifies about 320 MiB of potential
savings, not a completed optimization or demonstrated frame-rate recovery.
Sixteen large CPU DataTexture fingerprints are distinct; they do not justify
cross-model sharing. ImageBitmap pixels were not read back or converted.

- [x] Implement conservative within-source-material base/emissive reuse only
      after verifying immutable image identity, complete texture state and
      absence of texture-mutation bindings. Fail closed for unavailable or
      dynamic metadata; keep per-instance materials and existing ownership.
      Prove exact rendered pixels, sibling lifetime and fewer native allocations
      without reducing resolution, mipmaps or quality.
- [x] Obtain valid isolated-frame diagnostic evidence, not exclusive pass cost.
      Native16 traces the previously unowned writes to the update pipeline and
      leases the complete world tick while preserving Three's animation loop.
      Five queue-drained frames have identical draw receipts, no unowned queue
      work or GPU errors, and exact hook/resource cleanup. Their median GPU
      envelope is 65.405ms; median submit-to-idle wall is 74.3ms and includes
      driver/IPC/scheduling. This freezes a partial transition, not a ready world.
- [ ] Qualify settled, matched-population rendering and normal frame cadence.
      Native16's transition still fails; its deadline starts after two initial
      animation frames, so it is not exact cut-to-ready acceptance. Native17
      restores the original cut timing and also fails. Preserve focus, LOD,
      density, resolution, terrain and shadow settings; do not sum overlapping
      timestamp intervals into exclusive pass costs or infer FPS from them.

The seven-family/12-fish scope, 14-spot capacity target, two distinct docks and
shore access remain required. Concurrent fishing, inland placement/custody,
final art and sustained performance remain open. Evidence:
`inland-pond-integration01-UNQUALIFIED/native12–14/`, including
`native14/avatar-image-audit.json`, and follow-up `native16/process.json`
and `native17/grass-budget-ledger.json`. No production rendering or asset changes
were made in this diagnostic slice.

### Native pond follow-up — fishing delivered, transition still unqualified

Native03 verifies 14 actual client fishing entities, exactly two per family.
Its per-job observations distinguish slow completion from an observed restart
loop: 57 distinct job identities for 57 keys, monotonic sampled progress, and
stable pond focus after the initial update. The unchanged 30-second settling
gate still fails; this does not approve fishing capacity, native art, gameplay,
full streaming or sustained performance.

The next diagnostic profiles the actual Chrome/Metal scene at 1280 × 720,
pixel ratio 1. Native04 records about 20.96 seconds of sampled native buffer-write
time during a 29.85-second trace; about 19.995 seconds of that occurs in shadow
binding updates. Native05 counts 524 sun-shadow renders for 524 main-scene
renders, not duplicate shadow passes. Driver/GPU backpressure can appear as
buffer-write time: these observations do not establish redundant transfers.
Grounding is real work, but its roughly one second of active slices is not the
dominant sampled cost. No grass density, terrain accuracy, shadow quality,
resolution, timeout or work-budget gate was reduced.

Native07 subsequently identifies 16 raw instance-matrix uniform bindings by
exact array identity, including eight empty resource pools. The scoped GLB
tree/resource constructor fix preserves all transforms and existing dirty
updates while selecting version-tracked storage. Twenty real-class/owner
tests, 723-root source typing and scoped lint/format checks pass. An actual
Apple Metal fixture proves exact initial/final color and shadow pixels,
32,768-byte matrix agreement, zero unchanged uploads, one dirty upload and
real GPU allocation disposal. This verifies the static helper, not wind art.

Native08 removes those raw 512-slot bindings but still fails the unchanged
30-second pond transition. Significant native buffer-write time remains,
now including grass/vegetation matrices. No sustained FPS recovery is claimed.
Grass's private per-chunk matrices are the next bounded candidate; vegetation
needs separate alternate-geometry disposal and usage review. Keep all visual
detail and gates unchanged. All owned browsers and private runtimes/databases
are closed; human localhost and 145 protected artifacts stay unchanged.

Candidate zone/custody separation, concurrent all-tier fishing, dock/shore
approaches, bank routes and final visual review remain open. These diagnostic
profiles are not uncontended performance acceptance. Evidence:
`inland-pond-integration01-UNQUALIFIED/native03–08/` and
`storage-native03/`; full details are in the development checkpoint.

### Pond layout and fishing capacity — integration gates still open

The next art candidate keeps the current inland center and both dock approaches;
it does not establish final placement, ocean clearance or gameplay acceptance.
Native18's broad arena rectangle contains ten of the fourteen fishing targets,
the supplier and arrival landing. Seven targets' entire four-metre interaction
disks lie inside that rectangle. A pond safe-zone flag cannot override the
earlier arena no-loss shortcut, ground-item restrictions or lobby challenge test.

- [ ] Finish integrated custody qualification of the explicit facility footprint.
      Shared admission, zone cache and lobby affordances are implemented.
      Actual final-position source planning and PostgreSQL drop/ammunition
      commit/replay are now qualified at the sampled candidate locations below.
      Full death/grave dispatch, opt-out evacuation and queued challenge
      transactions remain open. Preserve ordinary safe-area custody outside
      facilities; never relax economic rules to fit the pond.
- [ ] Validate the full walking width of the pond-to-bank corridor against that
      footprint and full world collision. The exact painted-width/apron check,
      sampled dry-water separation and actual individual bank trips pass below;
      crowd clearance, dynamic actors and whole-layout circulation stay open.
- [ ] Complete native/persisted all-tier fishing capacity qualification.
      Actual CPU owners now admit fourteen anglers plus seven extra arrivals
      on distinct legal shores and cover cancellation, entity re-entry and
      relocation. Extend that observed arrangement to catch/consumable durability,
      authenticated socket reconnect, full world/dock collision, supplier/bank
      journeys, rendered crowd quality and long-run repeated spawn arrangements.
      Fourteen targets alone are not capacity evidence; CPU admission alone
      does not close this integrated gate.

### Pond headland and timber checkpoint — partial native inspection, unqualified

The source study adds a southern turf headland between unequal coves and a third
ground-cover sector. Water center, datum, envelope, four-sector limit and both
dock positions remain unchanged. Measured water area is 1,034.91m² versus
1,068.73m² (96.84% retained), shoreline 117.72m, dimensions 41.97 × 34.47m.
These are shape metrics, not proof of fourteen simultaneous anglers.

The actual admitted candidate's indexed mesh passes 169,560 probes: maximum
height difference 1.099cm and facet-normal difference 3.097°, within the existing
2cm/6° checks. Mesh normal buffers are finite/unit-length and shared seams agree.
The worst leaf uses 64,670 of 65,536 permitted extra vertices, leaving only 866;
the safety ceiling is not a scalability/performance budget. Full basin PhysX,
native shading, access/custody and live fishing remain separate gates.

Compact dock timber now uses stable dock/member/board identity and a shared
local growth field for side and cut faces, with derivative-filtered grain.
One material, zero texture assets, exact physical top buffers and the legacy
zero-mask path are retained. Legacy pixel equivalence is not established.
Structural material tests are not pixel or shimmer approval.
Final CPU gates: 15 dock tests; 91 canonical terrain/path/habitat tests with one
explicit candidate-only skip; seven actual-admission checks; 729-root source
typing, scoped lint and formatting. Water/fishing has 26 passes plus one existing
historical test incompatibility: that test imposes a 12m water envelope on the
27m basin. It fails identically against the immutable old candidate. Do not
report that full run as green or relax the production containment guard.

Build11 emits eight isolated bundles from 973 source inputs, preserving 145
protected compiled artifacts. Assets-v2 is an exclusive three-manifest overlay;
the old assets/native18 inputs are unchanged. Native19 and native20 both FAIL
the unchanged 90-second startup gate, with four and thirty grass cells pending.
The latter snapshot has thirty queued/running grounding jobs, no failed/waiting
jobs, and no LOD swaps. This is not a proven causal material/shape regression;
the new shore cover can change local grounding workload. No timeout, density,
resolution, shadow or operation limit is relaxed to claim success.

Both failed browsers closed with stable input pins. Their HTTP diagnostics
attribute the 503s to /api/streaming/state: this private art runtime deliberately
disables the duel scheduler, and the endpoint confirms that state. The known
missing-model 404 remains within placeholder scope, not this art task.
No final pond/dock art, fourteen-angler gameplay, stream or smoothness approval;
all LAYOUT-01–08 gates stay open. Receipts: native19–20, isolated-build11-report,
candidate-manifest-assets-v2-report and service-layout pond-headland/dock-growth
checks. A separate post-failure art inspection cannot erase these failed gates.

Native21 is explicitly an art diagnostic, not acceptance. It passes the original
90-second startup gate; its separate 60-second inspection allowance is unused.
All three original 30-second camera/grass gates pass at 29.06s, 11.69s and 4.37s,
with fourteen fishing entities (two per family). The overall run still FAILS:
the third capture encounters a changing HUD root, and its PNG contains the
loading-timeout overlay rather than usable jetty art. The first two captures
restore their HUD leases; camera and clock restore, input pins remain stable,
and the owned browser closes. Do not report three qualified captures or a
loading/performance pass; a recorded grounding slice still reaches 42.1ms.

Root visual inspection of the usable overview and landing rejects final art:
the southern headland improves the outline, but the bank collar and service
pads still read artificial, habitat is sparse, and timber remains visibly
grid-like/crosshatched. The submitted compact dock shader is captured in
native21/shaders. It confirms the compact field is active and retained legacy
terms have zero final weight for compact geometry. The half-metre board joints
can explain broad bands, not the finer second line family. Next isolate actual
board variation, filtered growth and constant PBR under unchanged geometry,
camera and light. Fragment-hash precision amplification remains a hypothesis,
not an established cause. Do not tune from that assumption without evidence.
The third PNG is not visual evidence of the jetty. Forty-one recorded 503s
again belong to the intentionally disabled private streaming endpoint.
Runtime12, its temporary database and all owned native browsers are closed;
the human client/server/database and protected bundles remain unchanged.

### Dock shadow attribution — controlled diagnostic, defaults unchanged

Native24 isolates the actual submitted board-variation and derivative-filtered
growth nodes, then renders constant PBR on the same geometry. Board variation
is piecewise flat and growth is not the fine orthogonal grid; the grid remains
under constant PBR. Do not implement the earlier fragment-seed hypothesis.
Native26 removes the grid only when shadow reception is temporarily disabled;
actual world-space deck normals are uniform. Native27 keeps casting/reception
enabled and changes only sunlight shadow bias from +0.0002 to zero: both the
constant and production timber controls lose the fine grid. This establishes
a shadow contribution for this held landing view, not universal shadow quality.

Every successful control run passes the original 90-second startup and
30-second camera/grass gates; camera transitions take 10.971s, 12.254s and
10.839s respectively for native24, native26 and native27. Each records five
complete HUD leases, restores original material/shadow/camera/clock ownership,
closes its owned browser and retains input hashes. Baseline/restored production
fragment SHA256 is af1761d806e1077b1946cd0d07e1dab83b2b90ad47076885286ca7f334f4f0e4.
No production lighting default, shadow map size, resolution or quality changes.
Review contact shadows, low/high sun, terrain, pavilions, foliage and moving
avatars before qualifying a bias change. The single-view controls are not
sustained performance, streaming, full-scene lighting or final-art approval.

Native22/23 failed diagnostic node selection because Three wraps expressions
in unnamed intent variables; native25 failed framework discovery after the
browser resource-timing buffer discarded its entry. These helper failures are
retained, not erased or attributed to production rendering. The corrected
probe unwraps only bounded unnamed intent nodes and observes the actual loaded
framework response to preserve Three identity. No replacement shader formula.

Native21's loading-overlay failure is now attributed separately: this private
runtime intentionally disables the duel scheduler, so streaming state remains
null and the independent UI's 120-second waiting-for-duel-data deadline replaces
the loading root during the third HUD lease. Terrain was ready. This explains
that capture failure but does not erase native19/20's real 90-second grass
startup failures or demonstrate stream readiness.

References: [Three LightShadow](https://threejs.org/docs/pages/LightShadow.html)
defines normalized-depth bias and the distortion tradeoff of normal offsets;
[WGSL interpolation](https://www.w3.org/TR/WGSL/#interpolation) informed the
discarded varying hypothesis. Actual native controls, not those general
references, establish the observed attribution. Receipts: inland pond
native22–27, with original build11 and assets-v2; runtime13 and its temporary
database are stopped, protected human services unchanged.

### Fishing approach and dock support correction — scoped verification

Fishing now admits only supported, available shore tile centers within the
authoritative four-metre interaction radius. The search uses four tile rings
rather than ten (at most 81 instead of 441 candidate checks). Rejected movement
releases the shore reservation and arrival emote. After actual route exhaustion,
a pending attempt can choose a different legal shore once per tick without
resetting its deadline or completion identity. Recovery requires movement-owned
failure evidence for that exact destination, not merely an idle actor; active,
deferred and precomputed routes retain their ownership. Explicit stops,
replacement intents, synchronization and cleanup clear stale failure evidence.
No movement budget, obstruction retry count or gather deadline increased.

The new cases exercise actual terrain, occupancy, resources, tools/inventory
and movement owners. They cover occupied shores, the exact reach boundary,
rejected pathfinding, reservations/cancellation/disconnect, actual resource
relocation, four distinct arriving anglers, real obstruction retries, actual
BFS deferral and intentional stops. The three old mocked fishing cases are
superseded by these owner tests; unrelated legacy tests remain. The independent
review found and resolved an intentional-stop restart regression before freeze.
Final canonical regression06 passes 68/68; immutable baseline05 and candidate05
each pass the 18-case real-owner file with stable manifest identities. Server
source typing covers 3,954 transitive files with zero diagnostics and stable
pins; scoped lint/formatting pass. Wrong-destination failure queries and clearing
an already-present failure on stop/replacement also have actual-owner coverage.
These are CPU approach/admission checks, not transport, catches, persistence,
fourteen-concurrent-angler, overflow or economic/custody acceptance.

Compact dock support caps now meet the actual 12cm plank underside; support
shafts meet the cap underside rather than overlapping the deck's walkable top.
All 16 supports / 32 members retain their count and canonical bottom placement.
Landing remains 2,703 vertices / 1,432 triangles, jetty 3,063 / 1,576; deck
position/index prefixes remain exact. Sixteen dock cases pass, including real
Three top-surface rays, 86 retained native PhysX rays plus 16 support-site rays,
and five exact whole-buffer historical geometry goldens. No shader, material,
texture, seed, collision top or shadow setting changes. The broad type gate
passes 729 roots with zero diagnostics and stable source pins.

Build12 emits eight isolated bundles from 973 stable production inputs while
preserving all 145 protected compiled artifacts. Native28 uses those exact pins
and assets-v2 in real Chrome/Metal WebGPU. The original 90-second startup and
30-second camera/grass gates pass (10.209s from the landing camera cut). All five
HUD leases complete; material/shadow/camera/clock ownership and input hashes
restore, and the owned browser closes. Root visual inspection confirms that the
landing's overlapping support-cap patches are gone. The fine grid remains at
the original bias and disappears in the temporary zero-bias control; final
production shader hash is unchanged. This single pose does not qualify both
docks, lighting across the world or final art. Native28 records 32 expected
scheduler-disabled streaming HTTP503s and one known placeholder-mob model404,
not an error-free stream claim.

Runtime14 and its temporary database are stopped with protected human services
unchanged. All LAYOUT-01–08 gates remain open, including arena/custody separation,
fourteen-angler capacity and sustained performance. The pond bank collar,
uniform planting and simple dock silhouette still need art work.
Receipts: service-layout fishing-approach-regression06, baseline05, candidate05,
types06, dock-support-* and pond-dock-cap-types01; inland pond native28 and
isolated-build12-report. No promotion of the unqualified pond manifests.

### Facility separation and all-tier capacity — candidate source checkpoint

Explicit `duelProtection: "facility-floors-v1"` compiles immutable ring, lobby
and hospital rectangles with the same one-metre apron as the authored floors.
It is a union, not their bounding box. All existing no-loss death, grave/drop,
ground-item persistence, ammunition, opt-out and resource exclusions consume
that shared protection predicate. Ring-only combat authority is unchanged.
Zone detection uses actual components for membership, precedence and cache
edges; a pond overlap cannot replace the actual lobby with pond classification.
Client/server challenge affordances share the lobby-floor predicate, excluding
hospital, ring and apron; the queued callback rechecks both participants.

Mandatory manifest admission rejects malformed modes, missing/non-finite/
reversed/escaping envelopes and inconsistent or duplicate arena identity before
readiness, even with SKIP_VALIDATION. Unmarked historical manifests keep their
broad-zone behavior. Only detached assets-v4 opts in: world-config and stores
remain byte-identical to assets-v2, while world-areas adds the facility policy
and explicit safe arena_grounds. The grounds preserve ordinary safe-area rules
between facilities; a half-tile outward shoulder on lower edges includes the
formerly protected boundary tile centers without changing generic zone rules.
Assets-v3 is retained as the rejected exclusive-minimum-edge study. No live
manifest, protected compiled output or human service is promoted.

The new opt-in actual-owner fishing case spawns fourteen body-bound resources
(two of each family, all twelve fish), equips real players with manifest tools/
consumables and skill levels, and runs actual movement/admission. The observed
v4 arrangement admits all fourteen plus seven extra arrivals on twenty-one
distinct supported in-range shores. Real click cancellation, entity removal/
re-entry and resource relocation finish with active sessions and no pending
gathers, shore reservations or movement intents. This is not reward execution,
DB/socket reconnect, full town/dock collision, a bank journey or proof of every
randomized spawn arrangement.

Verification: final regression03 passes 152 shared cases, including actual
World/ZoneDetection cache edges and real-filesystem admission; 68 server
regressions pass with one intentional opt-in skip; candidate-v4 runs the full
19 with zero skips. Shared source typing covers 731 roots and server typing
3,953 transitive sources, both zero diagnostics/stable pins; scoped lint and
formatting pass. Existing mocked death/custody suites are regression coverage,
not real transaction acceptance. Early fixture/typing failures remain recorded;
no timeout or budget increased. Build13 emits eight isolated bundles from 973
inputs with 145 protected outputs intact.

Native29 checks the actual admitted client predicates and zone owner at eight
ring/lobby/hospital/grounds/pond points; all match, including the legacy lower
boundary and pond/lobby overlap. Its original 90-second startup gate passes;
camera/grass settling is 11.008s within the unchanged 30-second gate, and all
five HUD leases complete. Root inspected the dock captures: the grid remains
at production bias and disappears in the temporary zero-bias control. Original
materials, shadow bias, camera and clock are restored. This diagnostic is not
gameplay transaction, final-art, streaming or sustained performance acceptance.
The isolated scheduler is disabled (31 known streaming-state 503s); one known
cow-model 404 remains. No error-free-runtime claim is made.

Native29's browser is closed; runtime15 is STOPPED with no cleanup errors and
its ephemeral database removed. Protected artifacts remain unchanged. The
playable localhost session and its database are untouched.

All LAYOUT-01–08 stay open. Next: real custody/queued-challenge transactions and
full-width bank routes, then whole-scene shadow qualification and stronger
bank/planting/dock composition. The current shader bias and all quality settings
remain unchanged. Evidence: service-layout arena-footprint-* and
fishing-capacity-candidate-v4-01; inland pond assets-v4 and build13 report.

### Final source placement and PostgreSQL custody — bounded qualification

Actual GroundItemSystem planning reproduced a historical fractional-edge defect:
an unprotected request at z=348.49 snapped to the protected tile center z=348.5.
Single, batch and direct-spawn paths now recheck the final grounded position
before returning a durable plan or performing persistence, merge or presentation.
The compact integer-edged facility policy remains unchanged. Real manifest/World/Terrain/
EntityManager cases cover 36 component-edge samples, the two fail-before
planning cases and direct-spawn rejection. These four new actual-owner cases
plus 19 existing regressions pass; older mocked cases are not actual-owner proof.

Candidate PostgreSQL tests join actual grounded source planning to the real
fully migrated database, not substituted receipts. All three facility centers
reject source planning and recovered-arrow requests with no inventory/equipment
debit, operation, source or contribution. Dry pond (383.5,410.5) and grounds
(316.5,356.5) retain ordinary item-drop and ammunition custody. Fresh World/
database owners and pools replay the same operations with exact quantities,
source coordinates and one debit. All 15 PostgreSQL cases pass, including the
existing safe-death outage/recovery transaction regression. That older case is
not a new pond death-handler qualification. No projectile flight, authenticated
transport, caught-fish reward, banking transfer or crash test is claimed here.

The first candidate fixture incorrectly treated the entire water-body envelope
as submerged; actual underwater classification corrected that setup without
changing authored placement or weakening the dry-ground requirement. PG02's
14 gameplay tests passed but its cleanup observation raced Docker auto-removal.
The exact container was subsequently verified absent; PG03 and final PG04 record
clean automatic removal with a bounded observation. Each database was private/tmpfs; human
services and data were untouched.

Source-aware shared typing passes 732 roots with zero diagnostics/stable pins;
the candidate database file passes 3,165 transitive sources with zero
diagnostics, scoped lint and formatting. Build14 emits eight isolated bundles
from 973 stable inputs, preserving all 145 protected artifacts. No manifest,
served build, visual default or graphics-quality setting is promoted. This is
functional qualification, not native rendering or sustained performance
acceptance. Evidence: service-layout shore-source-before02/after02/types02,
facility-custody-pg01–04 and facility-custody-types04; inland pond build14.

### Actual pond-to-bank routes — traversable, not final layout approval

The opt-in actual-owner route lane loads four real terrain/content tiles,
generated and authored resources (48 live in the final observation), all eleven
manifest NPCs, the real bank station, arena collision walls and native CPU
PhysX dock/court/rock collision owners. Both docks have 24 support tiles. No
fake walkability, occupied-deck workaround, moved resource or substituted
movement owner is used.

The final candidate run completes sixteen round-trip cases / thirty-two legs: both
docks, one actual approach for each of seven families, and a verified dry
non-dock approach for each family. The non-dock cases reuse the seven family
start coordinates; these are sixteen executions, not sixteen distinct origins.
Every trip reaches the real
station_bank_spawn authorization boundary and returns. No sampled end-step
tile is statically blocked; root support matches the authoritative support
resolver. The full painted corridor capsule has no exact intersection with
the protected floor/apron rectangles; 34,432 perimeter samples find no pond
water. This is sampled water evidence, not continuous swept-body proof.

Observed candidate05 legs take 39–64 logical movement ticks (not wall time or FPS).
Unconstrained movement crosses traversable lobby/hospital floors on 21/32
legs; that is retained design evidence, not a forbidden-traversal regression.
The painted path is not movement authority. No invisible wall, road-only
movement rule, immunity exception or pathfinding budget change was introduced.
Earlier route03 had a different actual randomized arrangement and timings.
The final full-file run passes 20/20 using the checked-in server test config;
the opt-in route mode resolves actual PhysX and dock/court source without any
machine-local config or rebuilt dist. Source-aware server typing covers 3,954
transitive sources with zero diagnostics and stable selected pins, and scoped
lint/formatting pass.

Only one bank exists in this candidate. Add a well-composed outlying bank as
part of LAYOUT-02 and compare journey budgets rather than constraining free
movement to the painted corridor. Whole-world route/custody design remains
open, as do bank deposit/withdrawal, simultaneous traffic, dynamic mobs,
rigid-body stepping, rendered crowd quality, repeat arrangements and long-run
fishing rewards. No LAYOUT-01–08 closure or manifest promotion. Evidence:
service-layout pond-bank-routes-candidate-v4-01–05 and
pond-bank-routes-types01. Initial PhysX-loader/root and fixture occupancy/
entity-removal failures are retained; they are not gameplay acceptance.

### Secondary pond bank — candidate integration, not layout approval

The checked-in basin study now places a second open banking court at (384,438),
with chest (382,436) and clerk (386,440), on the southwest turf shoulder.
Fifteen actual-owner site probes informed selection; the chosen pre-station
10m roof envelope had 0.4132m sampled relief, supported feet and no observed
water, protected-floor, dock, resource or static-collision conflict. It is not
a new whole-court terrain pad. Detached assets-v6 replaces singular service
architecture with three explicitly bound courts while preserving the primary
bank and smithy coordinates. V5 is rejected: its clerk was absent from the NPC
catalogue. V6 includes the real bank-clerk definition and actual server spawn.

Nearest-bank discovery had a reproduced production bug: deposit-all selected
the first bank and then treated that mutable selection as an explicit filter.
Only an actual requested bank ID now filters discovery. The unchanged real
World/player/inventory/BankEntity/PostgreSQL regression fails before and passes
after the fix; all 16 PostgreSQL cases pass. The test deposits at a real second
bank fixture, reads/withdraws the same player balance in town, preserves exact
ID and range rejection, and proves replay without a second debit. This is not
a final-layout socket/crowd/restart test. Existing agent-bank regressions pass
43/43. Legacy in-memory BankingSystem/NPC event actions remain an independent
single-authority audit gap; do not infer their retirement from this result.

The outlying station's existing square blend exposed a retained-mesh mismatch:
at (385.5,439.5), canonical and indexed heights differed by 27.541mm.
Opt-in plural bank stations now reuse the bounded feature-aligned collar
partitions. No height rule, global grid, resolution, geometry cap or quality
setting changes. Focused actual-source proof reduces the witness to 0.000575mm;
6,561 envelope probes stay within 0.462349mm and all 36 footing probes within
0.098293mm. The actual affected 128-grid leaf adds 1,144 vertices, 2,288
triangles and 91,520 geometry bytes; its maximum per-cell triangle count and
all geometry caps are unchanged. This is sampled geometry, not frame approval.

Native30 admits two real banks and three rendered courts, but fails the original
30-second overview grass-transition gate. Native31 captures the outpost on
Chrome/Metal with the unchanged 1280×720 profile and an 11.78-second arrival
transition. The view is rejected for final art: tall grass crowds the interior,
there is no composed worn connector/arrival, and the outpost repeats the town
bank silhouette. No finished world, smoothness, stream or performance claim.
Native32 repeats the same outpost camera with the refined build16; its arrival
settles in 9.56 seconds, but the original 90-second startup gate fails. The
existing post-failure art-only inspection retains that failure. Native31/32
are matched placement views, not deterministic pixel comparisons (wind and
world actors remain live). Both owned browsers and private runtimes are closed.

The route expansion also exposes an unresolved real return failure:
(418.5,432.5) to town succeeds, but returning can stop at (394.5,408.5).
The final search reports 250 iterations, a partial result and an available
destination, yet exact movement is abandoned. V6-04 records fourteen
complete same-start comparisons: pond-bank round trips take 16–66 ticks versus
78–134 for town, saving 29–102 ticks per pair. Two town returns fail; their
secondary comparisons are skipped without teleporting. The one-bank v4 control
also reproduces two 250-iteration partial-return failures, so this is not unique
to the second bank. This is not 64-leg acceptance. All seven non-dock fishing
witnesses pass. Final v6-05 reproduces both failing return destinations
(418.5,432.5) and (422.5,430.5): 28 journeys are recorded, 24 complete and four
town returns fail; their four secondary comparisons are not attempted. Twelve
same-start comparisons complete. The different random resource assignment does
not erase either failure or qualify the full route matrix.

The crowded relocation failure is now attributable: a fisher at (391.5,425.5)
is boxed in by water and two occupied cardinal tiles after the fish moves to
(391.5,418.5). The only dry diagonal cannot legally pass those occupied corners;
movement rejects after one search iteration. Capacity needs safe circulation
and coordinated yielding, not extra pathfinding budget or illegal corner cuts.
At that checkpoint both failures were blocking. The bounded-navigation result
below supersedes the search failure; the independent crowd blocker remains open.

- [x] Preserve/resume bounded ground-floor detour search; distinguish unfinished
      frontier from exhaustion at unchanged budgets (CPU scope verified below).
- [ ] Preserve escape/circulation space and prove coordinated yielding plus
      relocation recovery under crowd occupancy; retain repeat arrangements.
- [ ] Compose an asymmetric worn arrival/connector, restrained planting and
      distinct outpost character; retain free off-path access and fish habitat.
- [ ] Close banking authority, authenticated transport, restart/concurrency and
      whole-layout route gates, then matched native art and sustained performance.

Final canonical verification: server regressions 68 passed / two intentional
candidate skips; shared geometry/profile/water suites 78 passed / three
candidate skips. Focused v6 retained-surface cases pass 2/2; historical singular,
paired-shoulder and seam controls pass 3/3 with exact-buffer checks. Shared
source-aware typing covers 732 roots and server typing 3,954 program sources,
both with zero diagnostics and stable source pins; scoped lint/format pass.
The attempted whole v6 overlay suite had incompatible historical fixtures;
that failed receipt remains and is not presented as a full candidate pass.

Keep LAYOUT-01–08 open. Evidence: service-layout pond-outlying-bank-sites03,
two-bank-custody-before02/after01/types02/regression01,
pond-secondary-bank-candidate-v5-01 and v6-01–05,
pond-secondary-bank-regression02/types02/format04/lint03,
bank-collar-before01/after01/stock-regression02/v6-actual-final01/
singular52-final01/types-final01/eslint-final01;
inland pond assets-v5/v6, build15/16, runtime16–19 and native30–32.
Failed receipts are retained; the human localhost and its database are untouched.

### Bounded pond navigation — CPU recovery, not whole-layout acceptance

The two stranded pond returns are now deterministic regression cases, not
randomized success claims. Before the fix both rejected valid destinations
after 250 search iterations. Ground-floor non-combat movement now retains a
stationary-start guided frontier when its slice yields without a useful path.
Pending, found and exhausted are separate outcomes. Every heap pop, including
stale entries, is charged; the 250-per-search-slice and 1,000-per-tick limits, search
radius, legal diagonal corners and route deadlines are unchanged. Ordinary
useful segments are still published immediately; this is not a replacement
navigation framework or a larger search allowance.

Each paused actor owns copied goals, heap, parents and costs. Repeated intent
does not restart it; changed start/goal/arrival set/floor, relevant collision,
cancellation, synchronization, cleanup and world teardown retire stale work.
Collision owners publish effective changes from base flags, regions, leases
and network updates. Unrelated distant changes do not restart a job. Static
terrain caches survive occupancy-only changes, while affected directional
entries are invalidated because they include occupants and diagonal supports.
Same-tick cache failures were reproduced before this correction. At most 72
nearby edge keys are invalidated per changed tile; there is no full graph scan.

Retained work is limited to ground-floor owners with the change-notification
contract. Upper-floor topology keeps its historical one-shot behavior. This
does not claim arbitrary live terrain/profile editing, all building floors or
third-party mutation of exported collision arrays. Authoritative movement
still checks each actual step; no actor teleport or collision relaxation was
introduced. A route longer than the existing 200-tile returned segment now
keeps continuation metadata instead of prematurely appearing complete.

[Detour's sliced search](https://github.com/recastnavigation/recastnavigation/blob/main/Detour/Source/DetourNavMeshQuery.cpp#L1208-L1414)
and [shared-budget queue](https://github.com/recastnavigation/recastnavigation/blob/main/DetourCrowd/Source/DetourPathQueue.cpp#L72-L125)
informed explicit in-progress state, retained frontier ownership and consumed
work accounting. [Amit Patel's moving-obstacle guidance](https://theory.stanford.edu/~amitp/GameProgramming/MovingObstacles.html)
informed local invalidation rather than discarding every route for unrelated
world movement. These are technique references, not copied code or a new dependency.

This checkpoint supersedes only the earlier incomplete-route result, not the
crowd or visual rejection. Final actual-owner candidate02 passes 34 tests with
the known capacity case skipped; canonical regressions pass 68 with 17 opt-in
skips. The two deterministic stranded starts now arrive in 13 and 16 logical
ticks. The complete fixture records 32/32 round trips (64 legs), sixteen paired
comparisons from ten distinct physical starts. Town-bank trips total 1,623
logical ticks versus 591 for the pond bank in this arrangement. These are
sequential routes, not simultaneous throughput or wall-clock performance.

All seven non-dock fishing-family witnesses pass actual gathering admission.
Fourteen body-bound resources cover all twelve fish IDs, but this does not
prove every reward caught, fourteen concurrent anglers plus overflow, fishing
from both docks, physical simulation stepping, transport or restart behavior.
The two distinct dock meshes have valid deck–bank–deck routes; final art and
the full LAYOUT-07 acceptance remain open.

Shared movement regressions pass 397/397. Shared test-inclusive typing covers
707 roots / 2,382 sources, and server test-inclusive typing 3,954 sources, with
zero diagnostics and stable pins. Same-tick static/occupancy cache changes,
repeated intents, relevant/distant mutations, cancellation, synchronization,
missing-entity look-ahead and manager destruction have actual-owner coverage.
The five-player saturation case proves shared-budget deferral, not crowd
arrival performance. Scoped lint, format and independent review pass. Earlier
before-fix failures and test-fixture/type-harness corrections remain recorded.

Build18 emits eight isolated bundles from 973 stable production inputs;
build17 is superseded. Native33 uses build18/assets-v6 in actual Chrome/Metal
WebGPU at unchanged 1280×720. The original 90-second startup gate passes in
this run; outpost grass settling takes 10.88 seconds within the original
30-second capture gate. Earlier startup/transition failures are not erased,
and this diagnostic camera view is not native route gameplay, streaming,
seamless transitions or sustained performance acceptance. The court still has
excessive grass, no composed worn connector and a repeated bank silhouette;
final art remains rejected. Streaming-state polling returns 503 in this
isolated mode and the known unmodeled mob asset returns 404; neither is hidden
as a clean runtime. Owned browser33/runtime20 are closed and its ephemeral
database removed; human localhost/database and all 145 protected compiled
artifacts remain unchanged.

Evidence: service-layout pond-stranded-route-before01, pond-route-cache-before01,
pond-route-cache-candidate02/regression02/types02/lint02/format04,
guided-resume-tests02/shared-regression01/shared-types01;
inland pond build17/18, isolated-build18-report.json, runtime20 and native33.
No live/default candidate promotion, shader/density reduction or extra budget.

- [x] Recover the two deterministic stationary-start pond detours with retained
      bounded ground-floor search, precise invalidation and lifecycle tests.
- [x] Complete the sequential 32-roundtrip candidate CPU route matrix.
- [ ] Prove fourteen concurrent anglers plus overflow, every-tier dock/shore
      gathering, all twelve rewards, crowded relocation, departure and re-entry.
- [ ] Qualify native movement/gathering, authenticated banking/restart, repeated
      startup, outpost/shore/dock art and whole-island sustained performance.

The crowded relocation failure is separate and remains open: stationary
anglers can close another fisher's last legal exit. Next preserve an egress
option when admitting stationary fishing stances; any cooperative yield must
be owned by eligible autonomous agents, honor duel/private-preparation/operator
fences, and stop gathering through its real completion authority. Do not force
human movement, introduce invisible corridors, cut occupied diagonal corners
or increase the deadline. Preserve the fourteen-angler/all-tier/overflow
requirement when proving the solution.

### Inland fishing integration — candidate only

The detached candidate now requests 14 real fishing entities, two for each of
seven families covering all 12 fish. The body-bound resource owner admits only
wet targets with a dry approach within the existing interaction range, reserves
pending positions, and keeps relocation inside the same water body. The focused
28-test resource gate passes, including retries, concurrent reservations and
actual dry-shore reachability. This is not a live multi-agent fishing proof.

Both dock decks now have closed 12cm-thick planks and directionally aligned,
filtered timber grain, sharing one opaque rough material. Stock and art03 each
pass 18 layout/native-physics cases. Relocated habitat uses 28 instances in three
unequal groups; 111 habitat/palette/worker cases pass. Native appearance, route
integration and sustained cost still require separate evidence.

**Do not promote this placement yet.** The candidate partly overlaps the old
broad arena zone: ordinary fishing deaths, dropped items, opted-out agent
retention and duel-challenge eligibility consequently need explicit separation
and integration tests. Do not relax global economic/custody rules to hide this
layout conflict. The old pond-to-bank paint also crosses the lobby after pond
relocation; the candidate needs a verified dry route around physical floors.
The revised candidate paint route now passes 77 path/configuration/worker
cases around the lobby. The first real Chrome/Metal run nevertheless failed
scene readiness: the enlarged bank exceeded the existing terrain refinement
vertex cap in leaf `quad_68_d4_450_450`. Its loading-screen failure is retained;
there is no native art or performance acceptance. The test browser and private
runtime/database were closed; the human localhost session stayed unchanged.
All LAYOUT-01–08 checkboxes remain open. Evidence is in the local
`service-layout-network01-UNQUALIFIED/` and
`inland-pond-integration01-UNQUALIFIED/` directories.

Follow-up refinement source and native02 now resolve that specific terrain-load
failure without raising caps. Adaptive broad-bank refinement and balanced thin
strips retain old small-bank goldens;169,560 probes pass the existing20mm/6-degree
gates with10.99mm/3.10-degree maxima. Native02 reached29/29 terrain chunks,
122/122 grass chunks at its initial camera and ready water topology. Its later
pond-camera cut still failed the unchanged30-second grass-settling deadline
(four grounding jobs and one LOD swap pending). This is not a completed art
capture,14-entity client proof or performance approval; diagnose the transition
and verifier ownership before changing quality or deadlines.



## Island layout requirements — 2026-09-20, all open

These are required sub-gates of the world composition and verification tasks
below, not optional decoration or completed work. The island must feel like one
natural, inhabited place with purposeful destinations and useful open ground.
They supersede earlier single-bank assumptions and fixed pond placement/outline;
historical pond receipts remain evidence for their old profile only.

- [ ] **LAYOUT-01 — small pavilion town.** Compose the main banking, crafting
      and preparation services into a compact, recognizable town of open-sided
      pavilions, gathering spaces and clear landmarks. Avoid a service grid or a
      collection of identical roofs. Preserve circulation, diagonal travel, off-path
      exploration and overhead visibility; do not force all travel onto paths.
- [ ] **LAYOUT-02 — distributed banks.** Provide multiple actual bank access
      points across the island, including the town and useful outlying skill areas.
      Choose their number and positions from measured gathering/deposit/preparation
      journeys, not equal geometric spacing. Keep one player's authoritative bank
      inventory consistent at every location; verify access range, concurrent
      requests, restart persistence and agent discovery without duplicate balances.
- [ ] **LAYOUT-03 — distinct mines.** Place multiple recognizable mining areas
      with geologically coherent outcrops and different ore mixes, covering every
      launch ore and its progression requirements. Author counts, scarcity and
      respawn budgets explicitly; prove approach, depletion, regeneration and
      gathering-to-bank routes using the live resource entities.
- [ ] **LAYOUT-04 — tiered resource trees.** Spread real choppable tree species
      and tiers throughout the island in mixed groves, solitary landmarks and
      habitat-appropriate groups. Common tiers are abundant; higher tiers are
      progressively rarer. Validate authored counts by tier, spacing, accessible
      harvest faces, regrowth and agent targets. Inspect all LOD/crown bounds and
      batching/culling costs; decorative copies do not satisfy resource coverage.
- [ ] **LAYOUT-05 — local quest support.** Audit every launch quest NPC against
      the skill area and quest stages it supports. Place each near a suitable
      teaching/gathering/processing area, retain IDs and progress, and prove complete
      quest routes and hand-ins after relocation.
- [ ] **LAYOUT-06 — distributed rune altars.** Give the launch rune altars
      separate, thematically coherent locations around the island instead of one
      cluster. Preserve crafting eligibility, interaction ranges and identities;
      verify each altar's discovery, supply/bank route, clear approach and use.
- [ ] **LAYOUT-07 — natural inland pond.** Relocate the pond farther from the
      ocean-facing island edge and author an irregular basin with unequal coves,
      shelves, cutbanks and planted turf margins, not a circular ring or noise added
      to the same collar. Select placement in whole-island plan and eye-level views;
      record the minimum dry land separation from the ocean and retain a readable,
      traversable inland buffer. Revise the versioned terrain/water profile and
      coverage together; do not move only the visible water mesh or reuse old
      coordinate-specific approval. Re-ground fishing spots, plants, stones, nearby
      trees and paths; test indexed/rendered terrain against authoritative height,
      PhysX, water coverage, shoreline crossings and fishing/navigation access.
      Size the water and banks for all seven current fishing families (net, bait,
      fly, harpoon, cage, monkfish and shark), all 12 fish and their level/tool/
      consumable requirements. Reserve two accessible positions per family as a
      capacity target; prove actual spot availability and concurrent agent use,
      not only a configured type list. Capacity acceptance must exercise all
      fourteen positions concurrently (two anglers per family), including dry
      approaches, tool/consumable checks, rewards and spot relocation/retry.
      Test additional arrivals without trapped agents or blocked through-routes.
      Keep a usable shore option for every tier,
      a fishing supplier with bait and feathers, and a clear bank route. Author
      two distinct, restrained procedural docks with character, fitted landings,
      support posts and deliberate rail openings. Docks must use the pond's
      actual water level and shared deck/ground authority; verify entry, fishing
      reach, blocked edges, collision rebakes, cleanup and restart. Measure their
      draw/triangle/material and setup costs. Placement, capacity and dock count
      remain design targets until integrated visual and gameplay acceptance.
- [ ] **LAYOUT-08 — integrated acceptance.** Before promoting the layout, retain
      an annotated island plan, resource/service census and short journey budgets.
      Verify multi-agent gathering, deposit, crafting, questing and duel preparation,
      migration of persisted positions, restart/reconnect and resource lifecycles.
      Review close, overview, walking and stream views across daylight conditions,
      and measure target-hardware frame, loading and memory budgets. A new layout
      invalidates affected old route/grounding evidence; tests alone do not establish
      the required artistic or AAA-quality acceptance.

## Current world-art scope — open acceptance contract

**World first; avatar/armor later. One compact island and one arena remain the
only launch world.** This direction supersedes older preservation language for
enclosed procedural buildings; the Review75 shoreline gate below is separate.

- [ ] Replace every procedural building/service shell in this experience with
  an intentionally authored **open-sided pavilion**. Use the existing furnace
  canopy as the simplicity and visibility baseline, not as a clone requirement.
  There is no enclosed-building or furnished-interior preservation requirement.
  Preserve authoritative bank/NPC/service/resource IDs and data, interaction and
  custody semantics, banking/preparation behavior and restart-safe state—not the
  enclosed wall topology or its old footprint. Regenerate actual collision,
  grass exclusions, walkability/navigation and approach geometry for the new
  posts/roof; remove old wall/door blockers and prove no invisible walls remain.
- [ ] Give the pavilion family cohesive character through readable silhouettes,
  rooflines, supports, materials, props and landmark hierarchy while maintaining
  overhead/stream camera visibility, agent circulation and uncluttered approaches.
- [ ] Rebuild the procedural duel arena and **all** associated arena assets,
  entrances, boundaries, spectator furniture, landmarks, details and effects as
  the island's single artistically excellent focal point. Integrate it with the
  pavilion/world language while preserving authoritative combat bounds, spawns,
  movement and results. Acceptance requires collision/navigation proof, clean
  fight-camera and stream readability for every phase/style, effect stress and
  measured rendering cost; this is an aspiration, not a claim of AAA completion.
- [ ] Compose one deliberate island layout rather than disconnected set pieces:
  distribute varied **real choppable resource trees** across groves and scattered
  groups; create ore-specific mining/gathering areas for every launch ore; place
  services, arena, bank/preparation and spectator spaces along short, readable,
  traversable routes while retaining useful off-route exploration.
- [ ] Keep visible trees/ores, selectable resources, collision, depletion,
  regrowth, yields, agent targets and persisted identities synchronized. Decorative
  stand-ins may not replace or duplicate live resources.
- [ ] Inventory **every runtime particle effect** across world, gathering,
  processing, movement, combat, arena, weather/water and UI/broadcast surfaces;
  give each an explicit retain/redesign/remove decision and visual-quality plus
  performance budgets for spawn rate, pooling, lifetime, overdraw, draw calls,
  GPU/CPU frame cost, memory and cleanup. No screenshot-only particle approval.
- [ ] Accept the finished world only after matched close/overview/stream views,
  day/night and moving-camera review, multi-agent preparation/gathering/dueling,
  full route/collision/resource-lifecycle tests, particle stress/fault cleanup,
  and measured target-hardware frame/loading/memory evidence pass together.

These are open launch tasks, not completed implementation. Existing shoreline
texture accounting remains **3 checked / 8 open**.

### Reusable foundations and lowest-risk implementation order

Reuse the current authoritative world/profile manifests, station/resource IDs,
terrain/navigation/collision gates, and the resource-tree batching, culling,
LOD, depletion and regrowth paths. The bounded owner inventory currently verifies
the canonical furnace/anvil [`open-timber-smithy-haven-v3`](../packages/shared/src/systems/shared/world/CompactServiceCourt.ts)
court at **(336.5, 337.5)**, generated through
[`OpenWorkshop`](../packages/procgen/src/building/generator/OpenWorkshop.ts), and
the sole compact bank [`compact-preparation-lodge-v1`](../packages/shared/src/systems/shared/world/CompactPreparationLodge.ts)
bank at **(350, 328)** with the current enclosed 8×8 layout. The launch
[`world-config.json`](../packages/server/world/assets/manifests/world-config.json)
sets `townCount` to zero, so a hidden procedural-town population is not another
conversion target. The first bounded implementation slice is therefore the bank
pavilion plus the existing smithy court, preserving bank NPC/service identities
and data while replacing and revalidating physical presentation.

For effects, singular
[`ParticleSystem`](../packages/shared/src/systems/shared/presentation/ParticleSystem.ts)
is the authoritative owner of the real pooled
[`ParticleManager`](../packages/shared/src/entities/managers/particleManager/ParticleManager.ts)
water/glow paths. Plural legacy
[`Particles`](../packages/shared/src/systems/shared/presentation/Particles.ts)
currently installs a no-op worker; it is not a production alternative or proof
that an effect is qualified. Arena, teleport, fishing and other callers still
need the planned complete census. This verified owner list is deliberately not
labeled exhaustive. The retained compact-island profile, route fixtures and
stream-camera gates are verification foundations, not accepted art.

1. [ ] Produce a read-only census that binds every procedural building shell,
   arena component/effect, service footprint, resource-tree/ore identity, route
   dependency and particle emitter to its current owner, manifest and lifecycle.
   Retain matched visual, collision, route and performance baselines first.
2. [ ] Define one pavilion presentation contract that leaves gameplay authority
   unchanged. Prove the bank-pavilion plus smithy-court slice with exact service
   interaction/custody semantics, newly generated post/roof collision, grass
   exclusion, walkability/navigation and approach geometry, overhead visibility,
   stream framing and cleanup. Remove the retired wall/door blockers and test for
   invisible walls before converting other shells or retiring interior presentation.
3. [ ] Treat the arena as its own pavilion-aligned landmark tranche: block out
   entrances, spectator furniture, combat boundary, landmarks, lighting and
   effects around unchanged authoritative combat geometry, then prove every
   phase/style camera and collision boundary before visual expansion.
4. [ ] Compose the island through versioned profile/manifests: move stable live
   resource identities into varied tree groups and ore-specific gathering areas,
   connect pavilion services and the arena with short routes plus verified open
   ground, and migrate persisted positions deliberately. Do not use decorative
   duplicates or remote interaction to conceal a broken layout.
5. [ ] Audit and tune particle families one at a time under fixed cameras and
   deterministic bursts. Preserve pooling/cleanup, establish per-family and
   combined overdraw/frame/memory budgets, then test interruption, LOD, reconnect
   and long-running multi-agent activity before retaining visual changes.
6. [ ] Run the integrated art/gameplay gate only after those bounded slices pass:
   real gathering, processing, banking, preparation, arena ingress, full duel,
   stream views and return-to-world, with matched images/video and target-hardware
   telemetry. Keep avatar/armor work deferred until this world-first gate lands.

**Bank pavilion art03 — bounded improvement retained; full-bank art remains open.**
The explicitly admitted `open-timber-bank-haven-v2` candidate adds two readable
post-mounted key signs and curved, asymmetric service wear. Actual geometry is
**1,492 triangles / 247,200 bytes**, still three meshes/materials and below the
unchanged 1,500-triangle guard. Historical smithy geometry and unaffected paths
remain exact; the old bank recipe is rejected instead of silently relabeled.
Tests pass **13** geometry, **32** path, **35** visual/cutaway, **11** native-owner,
**4** selected candidate-owner, **2** candidate-access and **37** client cases
(overlapping suites; do not sum). Strict shared/client source types, scoped lint
and isolated builds pass; all **145 protected compiled artifacts** are unchanged.
Native01 timed out before any art views; that failed cold-start receipt remains.
Native02 passes the unchanged startup gate and captures three actual Chrome/Metal
views with all three bank pipelines, complete HUD leases and stable input pins.
Independent review finds readable signs and resolved orphan braces, but chunky
plaques, a generic shelter, broad dark ground and angular grass still need work.
No motion, loading-time, full-stream, target-hardware performance or AAA approval.
Only the owned diagnostic browser, servers and temporary test database were
cleaned; playable **3333/5555/5556** and the human database are unchanged.
The expanded **LAYOUT-01–08** requirements above remain entirely open.
[Art03 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/bank-pavilion-art03-UNQUALIFIED/README.md)

**Bank pavilion integration01 — candidate integration verified; art and launch acceptance remain open.**
The isolated, non-promoted candidate places `compact-bank-pavilion-v1` at
**(350, 320)**, moves the existing clerk to **(352, 322)**, preserves bank,
service and resource identities, and removes the retired lodge collider. The
generated post/roof collision, four-foot grass exclusion, camera cutaway and
complete approach paths are integrated. Grass-exclusion capacity is explicitly
32 for **25 actual polygons**; none was dropped. Candidate access passes **2/2**:
**532** terrain samples have delta 0, all **27** required paths complete across
**1,473** checked edges, the four bank and four clerk approaches plus exact
pavilion center are reachable, and the true two-tile bank boundary accepts the
exact center; the offset tile center and four just-outside probes are out of
range. CPU checks pass **53**
historical-path, **2** candidate-path, **40** geometry, **37** actual-worker,
**11** native-owner plus **4** candidate-owner, and **32** initial-visual tests.
Separate fail-closed readiness checks pass **1** actual aggregate, **11**
real-system and **19** client-regression tests; scoped source typing, lint and
format checks are clean.

Private runtime03/runtime04 health and plugin-module identity pass. After the
type-only client exports, build04's **eight runtime JS bundles are byte-exact to
build03**; protected canonical runtime outputs stay unchanged, and no candidate
manifest is promoted. Native02 retains three valid
bank views with three submitted actual pipelines per view; its timed-out arena
overlay is invalid evidence. Native03 supplies a valid arena-first current-arena
wide baseline only, not a new arena implementation. Independent review still
finds the pavilion's scale, banking identity/dressing and ground/grass
relationship unfinished. These captures remain `ART_UNQUALIFIED`: they close
no architecture, motion, target-hardware performance, full-stream or launch
gate. Owned browsers, private servers and ephemeral databases are cleaned while
the protected **3333/5555/5556** processes retain their original PIDs. Next is
the bank pavilion identity/grounding art pass, then the single arena's
perimeter/material slice. All **seven** world-art tasks remain open; shoreline
accounting stays **3 checked / 8 open**.
[Bank pavilion integration01 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/bank-pavilion-integration01-UNQUALIFIED/README.md)

**Bank pavilion geometry01 — source geometry verified; all seven scope gates remain open.**
The fixed `bank-pavilion-v1` OpenWorkshop recipe with the existing Haven
architectural finish produces three batches at **1,300 triangles / 216,576
attribute-index bytes**. Its roof is nominally 8 × 8 m; eaves and trim extend
actual X/Z bounds to about **8.99 × 8.90 m**, so that is not an 8 × 8 collision
footprint. Final geometry suites pass **40/40**; focused inclusive TypeScript
covers **2 explicit roots / 688 files / 0 diagnostics**; scoped ESLint exits 0.
Retained first runs document the corrected truss-aperture assertion and
test-helper narrowing. Captured pre-edit default and Haven smithy buffer SHA-256
identities remain exact. This is geometry only: it is not integrated or visually
accepted, and no PBR/material, placement, physics, collision, cutaway, grass
exclusion or navigation behavior changed. Next is versioned-manifest bank
placement, generated post/roof collision and cutaway, removal of the retired
lodge exclusions/blockers, then native banking/service access and art proof.
All **seven** world-art scope tasks above remain open.
[Bank pavilion geometry01 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/bank-pavilion-geometry01-UNQUALIFIED/README.md)

### Arena art tranche — source audit and first implementation boundary

The 2026-09-20 read-only audit covers the **single** 20 × 24 m combat ring,
arrival/recovery courts and their associated presentation. This is not new
arena implementation or visual acceptance. The initial evidence search found
only older stills; the subsequent isolated bank integration now supplies a
[fresh native wide daylight baseline](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/bank-pavilion-integration01-UNQUALIFIED/native03/arena-current-wide.png).
The earlier native02 arena image is a timeout overlay and is not visual proof.
The valid image shows a readable but plain fenced slab and disconnected recovery
pad. Prioritize perimeter/ground integration and architectural hierarchy; its
intentional masonry running bond is not the shoreline texture-repetition defect.
Near, night, moving and actual-fight views are still required.

[`DuelArenaVisualsSystem`](../packages/shared/src/systems/client/DuelArenaVisualsSystem.ts)
owns perimeter architecture, pillars, coping, braziers, floors, banners, forfeit
markers and the recovery emblem. Its floors already use the derivative-filtered
[`DuelStoneMaterial`](../packages/shared/src/systems/client/DuelStoneMaterial.ts).
Source inspection finds a different color/roughness-only, unfiltered ashlar
shader on the fences, sharp box/cap profiles and four duplicate corner-post
placements. These are source-backed targets, not a fresh visual verdict. The
floor shader uses horizontal XZ coordinates and a top-face mask; it is not a
drop-in material for vertical architecture.

The first arena slice is one coherent **perimeter/post/coping kit**: restrained
bevels, readable footings and caps, deliberate timber/stone proportions and a
vertical-safe, distance-filtered material in the Haven palette. Preserve the
combat floor/support/depth bias, authoritative bounds, spawns, existing collider
transforms and camera behavior. Do not add a roof over combat. Current entry is
teleport-based and both server tiles and client PhysX close the perimeter; a
decorative entrance must not suggest a traversable gate that does not exist.
Keep the existing stream omissions for tall interactive props until explicit
camera evidence supports a redesign. Spectator furniture remains new scoped
work, not an existing finished set.

Provisional first-slice cost limits, **not measured performance approval**:
at most the existing ten perimeter instance batches, no additional materials,
at most 2,500 additional expanded triangles, and zero new textures, lights,
shadow passes or particle pools. Retain the existing eight fire emitters and
one recovery emitter through the pooled particle owner and teardown lifecycle.
All added detail must stay outside usable combat space. Later court/furniture
and effect work needs separate budgets within the full world-art scope.

Acceptance requires exact gameplay/support/collision identity checks, removal
of duplicated corner instances, matched near/wide and all duel-phase/style
camera views, daylight/night and moving-distance inspection, and actual draw,
triangle, shadow and CPU/GPU timing receipts. Start from the existing stone,
arena shadow/depth/streaming, grading, pool collision, single-arena and camera
regressions. No arena or broader world-art gate is closed by this audit.

**Review76 — grass lighting diagnosed; leaf-normal control rejected; acceptance remains open.**
Native08 captures **6 PNGs** and native09 **16 PNGs** at two held sun phases;
both exit 0 as `CAPTURED_UNQUALIFIED`. Actual direct and indirect grass-light
outputs are present, so the broad angular appearance is not simply an
unlit/output-bypass problem. The unit leaf-normal control makes the grass much
darker while preserving broad plastic-ribbon forms and is visually rejected.
Actual pipelines are restored: fragments are exact; vertices are exact or differ
only by restricted bijective generated `NodeBuffer` identifiers with the same
matrix and bindings. Both eight-pin sets remain stable, the protected playable
client/server/database are unchanged, and only owned diagnostic browsers and
leases are cleaned. The actual local server keeps duels disabled; stream
readiness remains false at `waiting_for_duel_data`, and the retained 503
endpoint is not stream admission. No production grass change or default is
promoted, and no natural-motion, performance, full-stream or whole-world quality
gate closes. All **seven** world-art scope tasks and shoreline **3 checked / 8
open** gates remain unchanged.
[Review76 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-grass-review76-UNQUALIFIED/README.md)

**Review75 — bounded shoreline/grass evidence complete; visual acceptance remains open.**
The explicit mineral-shore role reuses the existing stone PBR layer without
changing geometry, grass support, wetness, water, collision or routes; fine
grass restores the broader area envelope and bends its lower centerline. The
correctly selected historical-fixture run passes **834/834**, focused grass
passes **254/254**, test-inclusive typing covers **717 roots / 0 diagnostics**,
and native physical evidence remains **4 passes / 1 historical skip**. Native
Metal/WebGPU evidence includes four Review74-matched stills plus a new shore
view and **11.943 s / 11.821 s** bank/coast clips. Exact original-timebase
decode and every frame hash pass; the bank's 37 retained default-mux DTS
warnings are separately reproduced as 37 default-30-fps timebase collisions,
not exact-timebase decode failures. The explicit polling session shuts down
cleanly and verifies **32 pins**, but it does not repair default macOS FSEvents.
Grass is fuller and less needle-like, yet still reads as hard flat ribbons with
weak canopy depth; the dark pond contour and smooth fringe remain. No visual,
temporal, performance or default promotion is accepted. All **3 checked / 8
open** texture gates remain.
[Review75 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review75-UNQUALIFIED/README.md)

**Review74 — bank/stone improvement verified visually; whole-scene acceptance still open.**
The cutbank now meets the water without the prior detached mound; isolated
Blender-authored stone normals/tangents and matching PBR maps reduce triangular
silver highlights. Original rock geometry/UV/base color remain byte-exact,
778 triangles and texture budgets unchanged. CLI, official MCP and visual review pass.
Four matched native WebGPU stills and a 12-second rail show local improvement,
but the continuous brown collar remains. Pointed grass loses about 32% projected
near-leaf area and looks more pin-like, not fuller; its volume is NOT accepted.
Coastal motifs/soft blends and original-angle/distance/shimmer gates remain open.
Final **825/825 terrain tests**, **252/252 focused grass tests** (47 overlap),
**717-root typing**, lint, builds and actual **4 physical passes / 1 historical skip**
pass; 1,300 routes and 27 fishing tiles remain. Pond anchors change 322→320,
not unchanged coverage. Video: 329 decoded frames/11.97s, 81ms maximum recorded
gap, exact camera/anchor return, no decode warnings—not FPS or temporal approval.
The native run exits **1 / FAILED_CLEANUP**: Vite needs owned-group SIGKILL;
zero EPERM/remaining groups, browser/test database/volume/five ports cleared.
Evidence-audit success does not waive this lifecycle failure. Source sampling
review finds no new proven paired-map/normal-rotation bug; mip/contrast and
source-motif risks remain. No default/performance promotion; Mac remains on battery.
All **3 checked / 8 open** texture gates remain. Next: break the continuous collar,
restore convincing grass volume, test original-angle moving-distance appearance,
and diagnose the client shutdown hang separately.
[Review74 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review74-UNQUALIFIED/README.md)

**Review73 — coordinated bank trial implemented; native art result still rejected.**
Shared CPU/TSL habitat groundcover, deterministic worker/sync establishment,
two authored northern bank profiles and unequal reed groups are implemented.
Water/root safety, RNG and attempt budgets remain strict. Final **823/823 tests**,
**713-root typing**, scoped lint and normal shared/server builds pass.
Actual physical checks pass **4 tests / 1 historical skip**, including 1,300 routes
and 27 fishing tiles. Two rock repositionings fix retained burial failures;
blocking tiles change 56→55, and pond anchors 327→322—not unchanged populations.
Four native WebGPU views and an out-and-back clip prove the new rendered branch.
Reed grouping improves, but a detached brown mound/green apron weakens the bank;
the dark collar, flat grass and faceted shiny stones remain. This is not accepted AAA art.
The clip decodes 318 frames over 11.942 s, with 59 render samples and exact camera/anchor return;
a 170 ms maximum recorded gap and three mux warnings remain, not smoothness approval.
Strict native shutdown exits 0 with no EPERM/forced kills; browser, owned test data
and five ports are cleaned. Earlier lifecycle/HMR failures remain recorded.
The generated concept is explicitly **not in-game**. No art default or performance
claim is promoted; the Mac was on battery. All **3 checked / 8 open** texture gates remain.
Next: connect the physical cutbank/rock footing to the water, remove the apron/mound,
and qualify original-angle/distance/motion appearance and measured cost across materials.
[Review73 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review73-UNQUALIFIED/README.md)

**Review72 — wet cutbank transfer verified; visual improvement insufficient.**
A bounded opt-in soil-to-rock transfer now reaches the authored wet cutbank toe,
using shared CPU/TSL weights across PBR channels. Grass placement, geometry,
wetness, maps and defaults are unchanged. All **742 tests**, shared typing,
**711-root test-inclusive typing**, scoped lint and shared/server builds pass.
Seven native WebGPU stills include three matched views with identical saved
pond grass anchors, seven 1024²/11-mip/16× maps and unchanged compiled sampling.
The visible difference is too subtle: the brown pond collar, soft material border
and uniform grass edge remain. This is not an accepted AAA improvement.
The baseline coast transition fails its 30s grass deadline; both strict shutdowns
fail on retained EPERM. Owned resources/ports are cleared, but neither failure is waived.
No motion or performance qualification was run. All **3 checked / 8 open** gates remain.
Blend-chain review confirms no later weight overwrite; localized support limits the effect.
Next: coherent cutbank/sedge/turf composition, original-angle/moving-distance
comparison and measured cost—not more isolated scalar tuning.
[Review72 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review72-UNQUALIFIED/README.md)

**Review71 — real client ownership improved; lifecycle and HMR still unqualified.**
The launcher directly owns Vite under its existing verified Node22 runtime.
Actual client production build and native WebGPU startup/120 advancing frames pass;
strict shutdown still fails on retained process-group EPERM (and one dev run needs SIGKILL).
A real controlled Darwin zombie-only group reproduces EPERM in libc, Node and Bun;
this explains a possible race, not permission to waive historical inspection failures.
Native file notifications also fail below Vite in two local locations; HMR remains open.
The existing regression batch is **58/59**, with one unchanged CI Node-pin failure.
Exactly 25 ignored dataless public backups were moved intact out of the served folder;
none were deleted or hydrated, and active originals retain their hashes.
No art, motion, performance or launch gate is closed; all 3 checked/8 open texture gates remain.
[Review71 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review71-UNQUALIFIED/README.md)

**Review70 — leaf-volume shading refined; art, performance and lifecycle remain unqualified.**
Implemented opt-in transverse leaf shading and root contrast without changing geometry,
density, coverage masks, LODs, resolution or historical rendering modes.
The first native recipe was rejected for dark, sharp strips; its evidence/source is retained.
A softer refinement improves separation modestly, but close grass remains broad and flat.
All **470 tests**, **706-root typechecking**, scoped lint and shared/server builds pass.
Sixteen actual WebGPU images cover both iterations; compiled vertex/fragment controls,
geometry and saved anchors are verified. No default is promoted.
Refined 10-second samples: CPU p95 **8.9→15.2ms**, observed-pass union p95 **14.88→15.79ms**.
Those worse tails remain open; short samples do not qualify FPS, motion or performance.
Both refined runs fail strict client shutdown (SIGKILL/EPERM), correctly propagated by the
wrapper. Browsers, cameras/clocks, owned databases/volumes and all five ports are cleaned.
Next: better blade silhouettes and ground transitions with explicit coverage accounting;
counterbalanced performance/motion checks; directly owned client shutdown diagnosis.
Original shoreline repetition, whole-world presentation and all integrated launch gates remain open.
[Review70 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review70-UNQUALIFIED/README.md)

**Review69 — four-way native isolation captured; visual and lifecycle gates NOT passed.**
Sixteen actual WebGPU images compare baseline, grass lighting, boulder-map and bank-geometry variants,
with real submitted owners and pinned maps/geometry; no asset, selector or default is promoted.
Verification passes: **455 lighting + 4 physical + 15 policy + 37 validator tests**,
one historical physical skip, and **706-root typechecking with zero diagnostics**.
Grass gains modest contrast, but remains unaccepted; the uneven northern lip still leaves
a continuous brown outline and flat, uniform turf—not a meaningful whole-world art gain.
The asset-only boulder correction removes local silver triangular highlights; faceted geometry/normals remain.
Four 10-second observations report CPU p95 **7.2–8.7ms** and observed-pass-union p50 **11.21–11.40ms**,
not presentation/FPS, full-GPU-frame or performance qualification.
**Baseline03 and grass shutdown fail**: launcher exit 1 after game-client SIGKILL and one EPERM each;
rock02/bank exit 0. All cameras/browsers, owned databases/volumes and five ports are cleaned.
The wrapper now rejects returned cleanup failure, but that diagnostic fix is source-checked only—not native-rerun.
Original repetition, mips, motion, day/night, live contacts and AAA quality remain open: **3 checked / 8 open**.

- Pending: blade transverse volume and convincing root-to-ground contrast.
- Pending: stone geometry/normal faceting and genuinely authored roughness.
- Pending: coherent shoreline breakup, matched distance/motion coverage and strict shutdown verification.

[Review69 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review69-UNQUALIFIED/README.md) · [Native/postflight audit](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review69-UNQUALIFIED/postflight.json) · [Isolated boulder near view](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review69-UNQUALIFIED/rock02/candidate-near.png)

**Review68 — shared shoreline composition implemented opt-in; visual gate NOT passed.**
The strict sector mapping, shared CPU/TSL surface weights, worker/sync grass support
and restart-owned terrain/water binding are implemented. A masked-zone lock bypass
found during review was fixed and covered with actual-owner regression tests.
All nine complete suites pass **709/709**, with no skips; production plus nine tests
type-check with zero diagnostics. Shared/client/declaration and matching server builds pass.
Six matched **fixed-local-daylight** native WebGPU images confirm the real compiled
candidate, seven actual 1024² maps/11 mips/16× filtering, and unchanged camera/render settings.
Independent visual review finds only a subtle tone change—not a meaningful art gain.
The continuous brown collar, flat turf and faceted wet stones remain below the target.
An initial stale-build launch and a subsequent natural-clock phase rewind are retained;
fixed-light art evidence does **not** qualify natural timing, motion or performance.
Both successful capture sessions exit 0, restore clock/camera owners, close their browsers,
and remove their own no-money test databases; all five ports are clear.
Original repetition, near/grazing/distance motion, added ALU cost and full-world quality remain open.
Next deliver visibly distinct, physically grounded northern bank/groundcover composition;
do not substitute more source checks or another global roughness adjustment for visible progress.
[Review68 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review68-UNQUALIFIED/README.md)

**Review67 — roughness isolation complete; whole-shore quality remains UNQUALIFIED.**
Six native shaded/roughness/restored images show a high authored roughness input
on dry terrain and a lower bank input near water, not a global gloss-floor defect.
This is visual diagnostic evidence, not numeric readback, final-specular or
all-lighting acceptance. Separate rock props still look faceted/glassy despite
metalness 0 and scalar roughness 1; the boulder's map still affects its result.
Both views restore exact material roots/output/textures and actual submitted
native fragments. All 15 selected pins remain stable; diagnostic process and
launcher exit 0, browser closes and all five ports clear.
The generated concept and whole-shore contract are **design, not implementation**.
No production/default changes, builds or full regression suite are claimed.
Original repetition, material composition, the 45–120m normal fade and full
near/grazing/distance motion remain open; the shared gates stay **3 checked / 8 open**.
Next implement one authoritative bank composition with matching groundcover and
protected water/access, retaining seven maps/33 surface reads—not another cosmetic ring.
[Review67 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review67-UNQUALIFIED/README.md) · [Binding composition contract](/Users/lucid/Documents/hyperia/hyperia-implementation/docs/compact-island-environment-art-brief.md#whole-shore-composition-contract-review67-not-implemented)

**Review66 — modest northern-shoulder gain; whole-shore quality remains UNQUALIFIED.**
Matched native views show a local improvement, but the whole pond still reads
as a continuous brown oval beside bright, uniform turf. Retain this as an
**unqualified data-only direction, not a fix or default promotion**. The initial
28.14/28.10 inner-height proposal was rejected before geometry; both were
corrected to **28.08**, without relaxing guards. Earlier failures remain recorded.

**Four tests pass, with one historical skip.** Focused lint and the **704-root
test-inclusive typecheck** pass with zero diagnostics; no rebuilds.
Sampled canonical/indexed error
is at most **1.262cm against the unchanged 2cm gate**. The access proof retains
**27 protected tiles and 1,300 completed routes**; bounded partial-path replanning
warnings remain, so this is not a navigation-latency claim.

Baseline/candidate rails fully decode without null-decoder warnings:
**324 / 319 frames**, spanning **11.967 / 11.966s**, with **58 / 59 advancing
actual-render samples**. Recorder/HUD and exact camera return pass.
Each run preserves its own **312 / 328 bank anchors** on return; these are
undeformed anchors, not complete blade-contact or temporal-quality proof.
Both launchers exit **0**, browsers close and five ports clear. All **22 pins
within each run** remain stable; **21 common pins match**, excluding only
the deliberately different world-areas manifest. Prior shutdown failures are
not thereby fixed.

Exploratory cost observes **191 draws each**, **1,555,461 → 1,557,675 triangles**
and observed-pass-union p95 **14.614528 → 14.548992ms**. Background load and changed
geometry prevent a causal performance win; this is not full-GPU-frame or
60fps qualification.

Next: one **whole-shore** composition using coherent authoritative bank geometry
and matched groundcover while protecting access—not another isolated height
threshold adjustment. No AAA, repetition, temporal or performance gate closes:
the shared checklist remains **3 checked / 8 open**.
[Review66 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review66-UNQUALIFIED/README.md) · [Actual northern bank](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review66-UNQUALIFIED/candidate/candidate-wide.png) · [Whole-pond overview](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review66-UNQUALIFIED/candidate/candidate-pond.png) · [Native rail](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review66-UNQUALIFIED/candidate/bank-motion.webm) · [Media receipt](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review66-UNQUALIFIED/media-verification.json)

**Review65 — material isolation complete; visual and performance quality remain UNQUALIFIED.**
Nineteen actual native material-output images separate coverage, diffuse input,
shading normals and the existing compensated stochastic dirt layer. There is
**no convincing periodic grid in the inspected isolated-dirt views**; this does
not close the original repetition gate. The dominant uniform bank collar and
groundcover transition remain unresolved. No production code, art or default
was changed. These images do not justify adding an expensive histogram branch.

All **seven native textures have 11 mip levels**, with actual **16x sampler-cache**
evidence. This verifies installed sampling state, not image quality at every
distance or measured performance. All **27 selected pins and two helpers** remain
unchanged.

Both 12-second rails fully decode without null-decoder warnings: the initial
bank rail has **304 frames / 11.957s**, and corrected grazing rail **314 frames /
11.935s**, with **59 advancing actual-render samples each**. Recorder/HUD cleanup
and exact original-versus-return camera position, quaternion and FOV pass.
The first near rail is **dry-turf-framing limited**. Three decoded grazing
stills are useful coverage, **not full temporal, shimmer or mip acceptance**.

Native launcher shutdown exits **1** after game-client SIGKILL and an `EPERM`
observation. Browser/camera are restored and closed, all five ports are clear,
and the exact owned disposable database/volume is removed. This is **not a
clean lifecycle pass**; the failure and earlier evidence are retained.

Next: one coherent bank-shape and matched groundcover trial with protected
access, followed by the same near/grazing/distance evidence. All acceptance
gates remain unchanged: **3 checked / 8 open**, including full-world quality.
[Review65 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-texture-review65-UNQUALIFIED/README.md) · [Actual grazing bank](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-texture-review65-UNQUALIFIED/baseline/bank-grazing-original.png) · [Corrected native rail](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-texture-review65-UNQUALIFIED/baseline/grazing-distance-motion.webm) · [Media verification](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-texture-review65-UNQUALIFIED/baseline/media-verification.json)

**Review64 — clearer reed leaves, but still UNQUALIFIED development art.**
Six native stills and two rails show improved leaf readability, but stiff, flat,
repeated spear tufts remain. This is **not preferred final art or a default**.
The 15 reeds remain one batch: **964 vs 972 triangles**, exact material and
18-color palette; whole dressing stays **64 instances / six batches**.
Candidate/baseline **2,478 / 2,598 lowest-root probes** are below retained ground;
this is not proof of every crown contact or GPU-deformed vertex.

Both rails fully decode: baseline/candidate **352 / 356 frames**, with **61
advancing render samples each**. PNG colorspace warnings remain recorded.
Policy tests pass **7 Node + 7 Bun**; **34 distinct validator cases** have
passing evidence across corrected runs, **not one fully green full-suite run**.
The initial phase-.61 failure, first candidate hash rejection and test history
are preserved. Within attempt02, all **27 + 23 + 8 selected pins** stay stable.

Baseline/candidate cost windows observe **599 / 590 frames**, observed-pass
union p95 **14.41792 / 14.09024ms**, client interval p95 **18.7 / 23.1ms**
(max **26.7 / 105.9ms**) and **189 / 191 draws**. These are **not a controlled
win, complete GPU-frame measurement or 60fps approval**.
Baseline shutdown exits **1** after client SIGKILL and one `EPERM`; candidate
exits **0**. Cameras/browser, owned disposable databases/volumes and five ports
are cleaned up; the baseline failure remains explicit.

Next: bounded source-versus-stochastic/mip texture isolation, not another
broad parameter pass. Original grid recurrence is not proven by latest pond
images; the continuous brown collar and water remain separate open gates.
Exactly **3 checked / 8 open**; prior history and checklist lines are unchanged.
[Review64 receipts](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review64-UNQUALIFIED/README.md) · [Actual near view](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review64-UNQUALIFIED/attempt02/candidate/candidate-near.png) · [Native rail](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review64-UNQUALIFIED/attempt02/candidate/reed-motion.webm) · [Next texture isolation](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review64-UNQUALIFIED/next-texture-isolation.md)

**Review63 — northern-bank composition and reflection correctness improve; still UNQUALIFIED.**
Three matched native views show a local planting improvement, not AAA or
whole-shore acceptance. The actual census finds **64 instances / six batches**
and **2,598 lowest-central-root probes** below retained terrain; this does not
prove every leaf/crown contact. Thin lime reeds, dark foliage, uniform turf,
the brown collar and repeated shore motifs remain. No default is promoted.

**79 tests pass across nine focused files**, with one historical-profile skip.
Ordinary shared types, normal shared/server builds and the **712-root /
nine-test-file** inclusive typecheck pass with zero diagnostics. The initial
nine test-typing failures and earlier packaging/fixture failures are preserved.
The normal 27 pins remain stable; **20/21 extra pins** match because the root
diagnostic's minimum-support calculation was corrected and its original retained.

Actual reflection diagnostics verify pond plane **27.8**, camera **34 → 21.6**
rather than baseline **−2**, with sea level still **16** and one **640×360**
target. Disabled windows record zero callbacks; enabled/re-enabled windows have
**35/26 distinct frame/render-camera keys**, at most one callback per observed
frame. Reflection preference, instrumentation and strict readiness are restored.

The 12-second candidate rail has **357 decoded frames**, increasing PTS
**0–11.972s**, and **60 advancing render samples**; recorder/tracks/hooks,
camera and HUD restore. This is not temporal/mip acceptance. Candidate-only
exploratory cost records **592 frames**: observed-pass union p95 **14.7456ms**,
client interval p95 **24.3ms** (max **102.1ms**), **191 draws / 1,555,461 triangles**.
Background load and no review63 baseline cost prevent a controlled comparison,
full-GPU-frame or 60fps qualification.

**Both launchers exit 1:** baseline requires client SIGKILL; its post-reflection
admission failure is consistent with insufficient profile-settling time, but no
exact failed snapshot was saved. Candidate passes final admission; shutdown needs client
SIGKILL and has one `EPERM` group-inspection error. No groups remain; camera/browser,
exact disposable databases/volumes and all five ports are cleaned up. Neither
whole run is green.

Next finish a fuller reed/groundcover silhouette within the existing instance
budget and integrate its substrate through shared material/grass ownership;
not more density or ring-threshold tuning. Water subdivision/lighting-normal
coherence, original repetition and all other quality gates remain open:
exactly **3 checked / 8 open**. Review62's rejected art and all history remain.
[Review63 verdict and receipts](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review63-UNQUALIFIED/README.md) · [Actual northern bank](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review63-UNQUALIFIED/candidate/candidate-wide.png) · [Whole pond](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review63-UNQUALIFIED/candidate/candidate-pond.png) · [Native rail](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review63-UNQUALIFIED/candidate/northern-habitat-motion.webm)

**Review62 — variation improved, but the mown oval is rejected as preferred art.**
Four actual native stills show more bank/turf variation, but shorter grass
exposes an artificial mown oval. Reject these parameters as the preferred pond
appearance. The shared CPU/TSL margin, root-color/support and pre-grounding
clump-scale implementation remains within the existing `shore-contact-v1`
**opt-in only**; defaults are unchanged. This is not AAA or whole-world approval.

Verification passes **608 tests across five files**: 136 material, 12 palette,
396 selector and 64 worker/manager tests. Ordinary shared types, the explicit
**708-root test-inclusive** typecheck and normal shared/server builds pass.
Seven maps / **33 surface texture reads**, **17 rocks / 56 blocked cells** and
all **27 selected pins within each run** remain unchanged. No review62 motion
or GPU-cost trial was taken: art rejection deliberately stopped that work.
There is **no performance qualification** or claimed win from fewer/shorter clumps.

Baseline launcher exited **0**. Candidate exited **1** because one game-client
process-group inspection returned `EPERM` during shutdown; the later zombie
snapshot does not establish its cause. Browser/camera, exact disposable
databases/volumes and all five owned ports were cleaned up. Preserve that
failure, earlier failures and the unresolved full-client-packaging failure.

The generated pond paintover and its prompt are a **design target only**, not
in-game evidence or approval. Next coordinate natural bank shape, grounded rock
groups, vegetation and water. Source audit also identifies an incorrect pond
reflection plane (**16 vs 27.8 when reflection is enabled**), a single-center-fan
under-wave mesh and disconnected lighting normals; these are **not yet fixed**.
Original repetition, motion/mips, water, path/grass and full-world quality gates
remain exactly **3 checked / 8 open**; all earlier evidence stays intact.
[Review62 verdict and receipts](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review62-UNQUALIFIED/README.md) · [Actual baseline](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review62-UNQUALIFIED/baseline/baseline-pond.png) · [Rejected actual candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review62-UNQUALIFIED/candidate/candidate-pond.png) · [Concept only](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review62-UNQUALIFIED/pond-art-target-CONCEPT.png) · [Concept prompt](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review62-UNQUALIFIED/CONCEPT-PROMPT.md)

**Review61 — pond transition slightly crisper; not a substantial or preferred art result.**
The explicit `pondBlend=shore-contact-v1` trial narrows soil/turf coverage
around its existing midpoint, with shared CPU/TSL coverage and retained legacy
cliff suppression, wetness and relief/contact locality. Six actual native
stills were independently compared: the edge is slightly crisper, but the
continuous dark pond outline, painted transition and uniform turf remain.
Keep the experiment **opt-in only**, not an accepted pond appearance; defaults
are unchanged. No obvious square grid was visible; that does not close the
original repetition issue or motion/mip acceptance.

Verification passes **601 tests in five files**, shared types/builds, server
build and the explicit **708-root test-inclusive** typecheck. Seven maps /
**33 surface texture reads** remain unchanged; all **25 sampled terrain points**
match baseline/candidate exactly, and **27 selected candidate pins** stayed
stable. These bounded checks are not whole-world or visual acceptance.

The requested 12-second native candidate rail was recorded; temporal quality
remains open. Observed-pass union p95 is **18.67776ms across 518 baseline frames**
versus **18.546688ms across 523 candidate frames**. Two grass cells retained
different LODs/counts and camera histories differ, so this is **not a controlled
performance win**, full GPU-frame measurement or 60fps qualification.

Both launchers **exited 1** because their clients required SIGKILL; inspection
errors were zero. Chrome closed, exact disposable test databases/volumes were
removed and all five owned ports cleared, but the shutdown failures remain
open. The previous full-client-packaging failure is also unresolved.
Next address the whole-bank material/vegetation relationship and continuous
dark outline, not more small endpoint tuning. Whole-pond, repetition, mip,
motion, dry-ground, water, path/grass and full-world acceptance remain open:
exactly **3 checked / 8 open**, with all earlier evidence preserved.
[Review61 verdict and receipts](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review61-UNQUALIFIED/README.md) · [Close baseline](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review61-UNQUALIFIED/baseline/baseline-wide.png) · [Close candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review61-UNQUALIFIED/candidate/candidate-wide.png) · [Grazing candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review61-UNQUALIFIED/candidate/candidate-near.png) · [Whole-pond candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review61-UNQUALIFIED/candidate/candidate-pond.png) · [Native rail](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review61-UNQUALIFIED/candidate/candidate-motion.webm)

**Review60 — coastal boundary visibly improved; opt-in only, texture gates remain open.**
The explicit `coastBlend=cavity-v1` candidate reuses source-aligned rock AO
(cavity, not height) with conserved shared PBR weights and no added texture
reads. All six matched native stills and actual bound shaders were inspected;
the seven map hashes match and source graphs retain **33 texture-sample nodes**.
The boundary is narrower and less airbrushed, with clearer rock detail, but
bright green streaks/speckles still look painted, turf remains uniform and rock
fractures repeat. Retain this directional improvement **opt-in only**: no
default promotion or AAA acceptance. The excluded original pond looks unchanged;
one close strip without an obvious square grid does not close that issue.

Material tests pass **127/127**, selector tests **379/379**; ordinary and
test-inclusive types and shared/server builds pass. Both runs retain the
existing **17 rocks / 56 blocked cells** in all three strict view censuses.
Twenty-five selected pins stayed unchanged within each run. Review57 full
client packaging and earlier unrelated failures remain open.

Single instrumented windows have equal captured terrain/grass descriptors and
**465 draws / 3,958,245 triangles**: observed-pass union p95 is **29.16352ms baseline /
29.4912ms candidate**. These are not complete GPU frame times, a causal
shader-cost result or 60fps qualification. The candidate rail has **178 decoded
frames**, strictly increasing PTS **0–5.848s** and three clean extractions;
sampled frames do not qualify temporal/mip behavior.

Candidate shutdown remains **exit 1**: the client exceeded SIGTERM grace and a
group probe returned `EPERM`; the cause is unresolved. Browser, camera, test
processes, exact disposable database/volume and all five owned ports were
cleaned up, but this is not a wholly green native run. Next verify the original
pond near/grazing/moving views, shared path/grass ownership, root-color contact
and water wave/detail-normal coherence. Exactly **3 checked / 8 open** gates
and all historical evidence remain intact.
[Review60 verdict and receipts](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review60-UNQUALIFIED/README.md) · [Near baseline](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review60-UNQUALIFIED/baseline/baseline-near.png) · [Near candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review60-UNQUALIFIED/candidate/candidate-near.png) · [Original pond candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review60-UNQUALIFIED/candidate/candidate-pond.png) · [Moving-rail evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review60-UNQUALIFIED/candidate/candidate-near-motion.webm) · [Paired observations](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review60-UNQUALIFIED/paired-native-summary.json)

**Review59 — world-owned coastal integration passes; the rock arrangement is rejected as art.**
The explicit opt-in `compact-preparation-coastal-rocks-v2` production/runtime
path is implemented, with canonical grounding and the existing collision,
navigation, grass-footprint and instanced-LOD owners. Six strict actual-game
censuses pass: baseline **17 rocks / 56 blocked cells**, candidate **19 / 72**.
The original 17 native transforms and sampled support values are exactly
unchanged, including **zero Y delta**. This verifies reusable integration,
not natural composition or full navigation/gameplay acceptance.

Matched wide/near images still show small isolated, contrasting props on uniform
green turf; they do not break up the patterned cliff face or its soft material
edge. The original pond is visually unchanged. Reject this arrangement as the
shoreline solution; no candidate manifest, asset or default is promoted.
Next improve the actual material and edge transitions in matched coast and pond
views, not further isolated placement guesses. All whole-world texture gates
remain open: exactly **3 checked / 8 open**.

The historical-default suites pass **30 tests with 1 explicit candidate skip**;
the separate exact-review52 candidate run passes **2 tests, 5 filtered**.
The broader exact-review52 run's **27 passed / 4 failed** remains preserved and
open; no collision tolerance or historical oracle was weakened. Shared/server
builds, ordinary and test-inclusive types pass. Review57 full client packaging
remains open. These results do not qualify the current world as fully green.

The candidate's moving-rail recording has **327 decoded frames**, but both full
null-output decodes retain repeated-DTS muxer warnings. Sampled frames and render
counts are not temporal or performance acceptance; **no GPU timing was taken**.
All 19 selected pins stayed unchanged within each run. Both owned browsers,
processes and disposable test databases were cleaned up, and all five test
ports cleared. Earlier evidence and failures below remain intact.
[Review59 verdict and receipts](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review59-UNQUALIFIED/README.md) · [Near baseline](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review59-UNQUALIFIED/baseline/baseline-near.png) · [Near candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review59-UNQUALIFIED/candidate/candidate-near.png) · [Original pond candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review59-UNQUALIFIED/candidate/candidate-pond.png) · [Moving-rail evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review59-UNQUALIFIED/candidate/candidate-near-motion.webm)

**Review58 — all three bounded cliff fits rejected; world textures still UNQUALIFIED.**
The closed segment was not installed. Burying its unfinished shell/caps leaves
too little useful facade; surviving fragments contact the declared CPU movement
envelope. That is not actual PhysX/navigation proof or proof every redesigned
asset/site fails. Stop further shell-burial guesses: the next geometry task
needs finished natural return/cap surfaces or a deliberately redesigned,
jointly qualified canonical backing landform.

Actual current-game captures show the unchanged world in three control views
and a recorded pond camera rail with a six-second requested recording window,
not a cliff-candidate comparison. No obvious square dirt grid appears in the
inspected pond frames, but the broad soft bank transition, uniform turf and
recognizable coastal rock motifs remain. Sampled frames and advancing render
counts do not qualify temporal stability, distance/mips or performance.

Boot took **48.82 s**; grass readiness from the coast-wide, coast-near and pond
camera cuts took **4.905 / 0.503 / 6.462 s**. These are diagnostic waits, not
gameplay acceptance. Twelve selected pins stayed unchanged. Existing cow-404
placeholder logs remain; no other client-console warning/error or page error
was captured.
Recording hooks were restored, owned browser/server/REPL were closed, all five
owned ports cleared, and the sole disposable test database was cleaned up.

No production code/asset/default was promoted and no new review58 suite total
is claimed. Review57 full client packaging remains open. Original pond dirt and
all whole-world texture gates remain open: exactly **3 checked / 8 open**,
with all earlier evidence preserved.
[Review58 native evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review58-UNQUALIFIED/README.md) · [Corrected rejected placement study](/Users/lucid/Documents/hyperia/asset-studio/coastal-cliff-segment58-placement-UNQUALIFIED/README.md)

**Review57 — physical-material loader fidelity repaired; cliff art still UNQUALIFIED.**
The actual ModelCache path flattened authored Physical materials into Standard
materials. It now uses the existing native PBR-copy helper. Final processed-cache
schema **7 / policy v4** retains the existing database schema and rejects old
flattened rows by exact policy. Physical materials deliberately bypass processed
caching instead of silently losing their properties. The unnecessary schema-8
upgrade was withdrawn because an old open tab could block it; pre-existing
blocked-upgrade lifecycle limitations remain open. Final schema-7/policy-v4
verification passes **98/98 tests across six files**, normal shared type checking
and build, server build, ESLint and Prettier. Earlier native03/revision evidence
remains preserved in the linked review.

Isolated final native04 compares the original loader with actual ModelCache output
for the frozen05 full-cliff source on non-fallback Apple Metal WebGPU:
three views at **960x540, DPR1**, maximum reported linear pixel difference
**0.0001220703125**, and zero page, console, request or GPU errors. Owned browser,
server and diagnostic resources are closed; source/material/geometry pins remain
unchanged. An actual second IndexedDB connection stayed open on schema 7 during
loading with zero version-change events. This qualifies same-version loading,
not future upgrades or persistent-warm behavior. Native04 matches native03's
reported pixel deltas; neither is full-game art or performance approval.

Full client packaging remains open: the standard asset-copy step failed with
`EDEADLK` on the preserved dataless backup
`public/textures/noise3.jpg.dataless-backup-20260914-client-batch01`.
The file was not hydrated or deleted. Separate code-only compilation passes with
public copying omitted; this is not a deployable-package or public-asset pass.
Full public-asset packaging remains failed/open, without bypass acceptance.

The separate, uninstalled **14 m cropped-front, closed cliff segment** has three LODs at
**15,016 / 4,764 / 1,384 triangles** and passes structural checks. The front
retains detail, but caps/rear remain visibly jagged and require fitting/burial.
The **7,318 / 861 / 110 overlap candidates** are not triangle-intersection
proof. Modular cliff reuse is a production-art direction, not automatic visual
acceptance; the [original artist breakdown](https://gamesartist.co.uk/present-moment-farm/)
describes reusable cliff forms with smaller supporting rocks.

Full-game cold loading, persistent-cache behavior, terrain/grass contact,
collision/navigation, moving-distance LODs and measured cost remain open.
The original bare-pond dirt and every whole-world texture gate remain open.
Exactly **3 checked / 8 open** gates and all review56/earlier evidence are retained;
no asset/default is promoted and no commit or push follows.
[Review57 material-fidelity evidence](/Users/lucid/Documents/hyperia/asset-studio/model-material-review57-UNQUALIFIED/README.md) · [Review57 uninstalled cliff-segment evidence](/Users/lucid/Documents/hyperia/asset-studio/coastal-cliff-segment57-UNQUALIFIED/README.md)

**Review56 — Seaside Rock rejected as a full replacement; UNQUALIFIED.**
Paired native coastal wide/near and original bare-pond views, plus both
12-second coastal clips, complete the bounded source audition. Seaside Rock
at its verified 2 m width reduces recognizable fracture motifs compared with
Rock Face03 at 2.7 m, but reads as dark fine-grained earth with weak medium-scale
rock form. The soft bright-green fringe persists. This does not prove a normal
bug or that geometry alone is responsible. The original bare-pond still has no
obvious square grid in these views; its full texture-quality gate remains open.
`coastBlend` was omitted on both sides; no distribution experiment is promoted.

The first candidate boot failed strict PBR hash admission: `ASSETS_DIR` selected
manifests, while `/game-assets` preferred `WORLD/assets`. Correcting the isolated
harness's `WORLD` selection admitted the intended assets; all seven actual HTTP
and native texture hashes then matched. The failed boot is preserved, and no
asset-admission check was weakened.

All three temporary production calibration files were restored to their exact
original SHAs. Normal shared type checking and shared/server builds exited 0;
all eight rebuilt artifacts are byte-identical to baseline. Owned runtimes are
cleaned up and all five owned ports are clear. Native GPU cost was deliberately
not measured after art rejection, so no speedup or performance approval follows.
Restored-source verification is complete: the guarded Node run passed all
**521/521 tests across seven files**, packed-map tests passed **9/9**, and the
installed packer CLI `--check` exited 0, confirming six RGBA8 maps with the
original Grass004, Rock Face03 and Poly Haven Dirt sources. The incompatible
initial direct-Bun Vitest run (**513 passed / 8 failed**) is retained separately;
no code, test or acceptance criterion was weakened. These are source/packing
checks, not visual or performance approval.
No default is promoted, no quality gate is closed, and no commit or push follows.
Exactly **3 checked / 8 open** gates and all prior evidence remain intact.

[Review56 verdict and evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review56-UNQUALIFIED/README.md) · [Near baseline](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review56-UNQUALIFIED/baseline-near.png) · [Near candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review56-UNQUALIFIED/candidate-near.png) · [Original pond baseline](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review56-UNQUALIFIED/baseline-pond.png) · [Original pond candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review56-UNQUALIFIED/candidate-pond.png)

**Current verdict — review55 changes coastal classification, but is not art accepted; UNQUALIFIED.**
Matched actual wide/near captures show a clear effect from the explicit
`coastBlend=distribution-v1` candidate, unlike review54's negligible detail-mask
payoff. Main and independent reviews still reject the result as finished:
a dark continuous painted-looking soil collar, an overly bare lobe, bright
green fringe and brown stems remain. Recognizable rock motifs are unchanged.
The historical review54 rejection and all earlier failures below remain intact.

The candidate shares one broad material-distribution expression across terrain
PBR weights, analytical grass support and mean root color. It only reassigns
available turf to soil/rock, retains the original seeded acceptance/rotation
stream before thinning, and protects roads and the full admitted pond bank.
Geometry, source textures, projection, wetness and default selection stay fixed;
no additional texture reads or generic density reduction are used. This is an
opt-in experiment, not an accepted world-material replacement.

All **540 matched native sample points** retain exactly equal ground heights,
indexed shading slopes and sampled terrain resolutions. **153 low-shore and
8 western controls** retain exactly equal sampled native CPU root RGB and
placement values. These witnesses do not prove pixel-level PBR/root-color
parity, every blade's ecology, or unchanged output everywhere: analytical and
indexed normals differ. Final combined verification is recorded separately;
no unconfirmed final test total is asserted here.

Original bare-pond dirt, coastal soil/rock, paths, grass, water, texture scale,
near → gameplay → stream distance → return, and frame/loading/memory cost
remain open. No performance or AAA approval, default promotion, commit or push
follows. All historical failures and exactly **3 checked / 8 open** texture
gates are retained. Next resolve the visible broad soil/turf/rock composition
and root contact, then complete whole-world and moving-distance coverage;
do not hide the remaining bank defect with foliage.

[Review55 verdict and evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review55-UNQUALIFIED/README.md) · [Wide control](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review55-UNQUALIFIED/control-coastal-wide.png) · [Wide candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review55-UNQUALIFIED/candidate-coastal-wide.png) · [Near control](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review55-UNQUALIFIED/control-coastal-near.png) · [Near candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review55-UNQUALIFIED/candidate-coastal-near.png)

The user's quality bar applies to every world material, not just the dirt bank.
Keep this ahead of further decorative placement. Source tests or attractive
wide shots cannot close a close-up texture defect.

- [ ] Remove recognizable dirt/shore repeat motifs and patch-grid artifacts
  without blurring soil detail or hiding it behind vegetation.
- [ ] Review grass, paths, coastal soil, cliffs/rocks and water for consistent
  physical texture scale, visible repeats, seams and projection stretching.
- [ ] Preserve albedo/roughness/normal/AO/height alignment, correct color-space
  handling and coherent dry/wet response; dry ground must not read as polished.
- [ ] Replace soft painted-looking material borders with convincing ground
  transitions while preserving open traversal and shared grass support.
- [ ] Validate close, overhead and grazing views in motion, including near →
  gameplay → stream distance → return: no texture swimming, objectionable
  shimmer, mip color shifts or abrupt detail transitions.
- [ ] Compare actual GPU/frame/loading/memory cost at unchanged resolution and
  population before retaining a quality change. No automatic default promotion.

The earlier September19 texture capture observed all seven maps at16x, but
**review47 disproved reliable inheritance**: a later boot had seven loaded maps
at1x despite `ClientGraphics.maxAnisotropy === 16`. Texture construction can
precede the global default update. The strict quality gate rejected that run;
it was not timed or manually upgraded for comparison. Compact texture setup
now explicitly requests the intended16x for placeholders and decoded maps.
The earlier proposed4x downgrade remains withdrawn. Stochastic dirt sampling
remains a partial improvement, not final acceptance.

Review45 adds runtime filtering visibility and87 passing material tests, not
a visual fix. The close coastal image also exposes repeated rock features and
a soft green material border. No new sampler or shader was adopted.
[Texture review45 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-texture-review45-UNQUALIFIED/README.md)

Review46 adds an explicit opt-in `rockProjection=stochastic-v1` material branch;
**297 focused tests passed**. The same seven 1024x1024 maps and native 16x
filtering retain original physical scale and aligned PBR channels; terrain,
navigation and absent/default mode remain unchanged. With dirt and height
selected, static surface reads increase **27 -> 33**, plus ALU work. These
structural counts are not measured GPU approval.

**Native46 FAILED / UNQUALIFIED.** Intended matched `candidate-bank.png`
shows **APPLICATION BOOT TIMEOUT**, not an approved terrain comparison. The
candidate startup camera was installed before grass/sky owners were ready;
correct harness admission before drawing causal conclusions. Scene readiness
later became true, but global readiness remained false after the boot timeout.
Do not weaken, hide or rewrite the readiness gate or its failed evidence.

The control's 30s grass-cut check failed with 24 chunks still running. Candidate
focused cadence was 49.0 ms versus control 20.3 ms, but submitted triangles differed
(2,812,935 versus 2,630,259), preventing isolation of shader cost. **All GPU-cost
results are rejected** because resumed render passes reused timestamp slots;
no visual-improvement or performance acceptance follows.

Original pond-dirt repetition and the rock-bank candidate remain **separate
open gates**. Next bounded steps, without changing their acceptance criteria:

- [x] Correct diagnostic boot/grass/sky admission before camera installation;
  review47 now has actual naturally matched control/candidate bank captures.
- [x] Correct physical-pass timestamp ownership; schema2 validates real native
  captures and rejects corrupted or incomplete data. Review46 remains rejected.
- [ ] Complete separate dirt-pond and rock-bank near/mid/grazing comparisons
  plus repeatable motion, preserving detail, material alignment and budgets.
- [x] Attribute the pond's pale rim using actual native main-camera layer/cause
  shader outputs; review48 confirms a rock band where pond-soil coverage ends.
- [ ] Refine the remaining pond rock/soil/turf transition and bank profile;
  original dirt repetition, motion/mips and performance acceptance remain open.

[Texture review46 failed evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-rock-review46-UNQUALIFIED/README.md)

**Review47: progress, still UNQUALIFIED.** Matched daylight bank images reduce
aligned rock fissures without obvious stone-detail loss. The new bare-pond view
shows no obvious square grid in that still, but reveals a continuous pale rim,
dark substrate band and abrupt turf boundary. Neither original dirt nor overall
world material quality is closed by these stills.

298/298 focused tests, shared type check and development build pass. Candidate
cotangent inputs are shared without changing all33 texture reads or the expanded
normal expression; emitted derivative/cross pairs fall14->6. The filtering race
fix also survives both rebuilt native boots with all7maps at16x. Defaults for
rock/dirt/height selection, texture resolution and geometry remain unchanged.

At matched camera/daylight/settings, rebuilt control/candidate observed GPU-pass
union medians are16.515/22.938ms (p9518.416/24.773ms); client tick medians are
18.1/24.7ms. Each submits374draws/2,605,659triangles per tick. Full-scene grass
counts differ84,513/84,519 and visible-scene triangle totals differ, so this is
not an isolated shader-cost or statistical performance approval. Do not infer an
optimization factor from the earlier53ms candidate window at a different phase.

Native query/camera/HUD owners restored and owned test resources were removed.
The launcher nevertheless reported exit1 after client SIGKILL/EPERM inspection;
retain that shutdown failure even though subsequent process/port checks are clear.
No automatic default promotion, commit or push.
[Texture review47 evidence and next gates](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-texture-review47-UNQUALIFIED/README.md)

**Review48: attribution confirmed; bank refinement still UNQUALIFIED.** Actual
native main-camera layer/cause outputs identify rock along the pale rim, with
geometric cliff coverage where pond soil ends. The pond-only `height-v1`
sediment candidate transfers existing rock weight to dry soil without changing
shared wetness, grass support, geometry, navigation or default selection.

Matched daylight baseline/candidate start phases are **0.5898986 / 0.5898721**,
with equal camera and **1280x720, DPR1, MSAA4, seven 1024x1024 maps at 16x**.
The terrain profile, 52 terrain leaves and 94 grass chunks / 84,498 clumps match.
The candidate modestly reduces the upper pale edge, but a pronounced continuous tan
ring remains; grazing stills retain a manufactured bowl-rim appearance. The
candidate layer-weight image confirms remaining rock. These are spatial stills,
not motion/shimmer evidence, and neither original dirt repetition nor AAA
material quality is accepted.

**304 focused tests**, shared types, development shared build and verified
server build pass. Both emitted shaders retain **53 `textureSample*` call
sites** (7 ordinary + 41 gradient + 5 comparison samples), with source size
126,822 -> 127,694 bytes. This is not a surface-only budget or GPU-cost result.
No performance qualification was attempted on battery. Baseline/candidate boot
times are **106.533 s / 66.308 s**, and camera-cut settling **14.425 s / 8.629 s**:
readiness completed, but this is explicitly not smoothness approval.
Cumulative grass max slices are **10.8 ms / 5.4 ms**, both above the 2 ms target;
no causal performance claim follows. Zero page exceptions do not mean a clean
console: 11 errors include missing-cow 404s and one unattributed generic 503.

The initial build-manifest rejection is retained; normal rebuilding preceded
the substantive runs. Both substantive launchers exited 0, owned browsers closed,
material/camera/HUD ownership restored, and the verified stopped disposable
database/sole-use volume were removed; source, assets and evidence remain.
No default promotion, commit or push.

Next: inspect the actual bank height/slope transect alongside final material
weights, then make one cohesive bank-profile/material pass. Do not substitute
blind threshold nudges, more texture samples or decorative coverage for that
decision. Keep separate original dirt, motion and performance gates open.
[Texture review48 evidence and next gates](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review48-UNQUALIFIED/README.md)

**Review49: localized bank-shape improvement; still UNQUALIFIED.** An actual
25-point indexed-geometry/normal transect places the visible pale rim at pond
radii **7.00–7.25 m**. The earlier target **0.331 m above water was lawn**, not
the rim. A new explicit review49 overlay adds only a third shallow bank sector;
preview44, defaults and all material/shader sources stay frozen.

At matched bank poses, daylight starts at **0.58991354 / 0.58955883**, with
**1280x720, DPR1, MSAA4, post-processing off**, and the same seven
**1024x1024 / 16x** maps. Root and independent review see clear local pale-rim
removal, not whole-pond acceptance. The close view retains a soft airbrushed
soil/turf boundary, uniform lawn and a far-left pale edge. The new overview
still shows a continuous dark perimeter and regularly spaced detached rock
groups; original dirt repetition, motion/mips and full-world quality remain open.

The first candidate run passes **30/30 tests across two files**, with a further
**3/3 native-physics fixture tests** passing. The frozen preview44 regression
passes **2 tests, 1 skipped**, retaining the same routes. Forty retained-mesh,
Three.js and PhysX probes stay within the unchanged 2 cm canonical bound.
Sampled terrain leaf triangles increase **74,034 -> 74,758 (+724)** across the
same 52 leaves. These checks are not actual player-walking or GPU acceptance.
Expanded test typechecking initially found three diagnostics; fixes now pass
shared types and the explicit two-test program with zero diagnostics. Final
post-fix native candidate **3/3** and historical preview44 **2 passed / 1 skipped**
reruns pass with exactly equal navigation receipts. Native boot
**101.109 / 52.858 s** and bank-cut settling **12.950 / 8.507 s** are observations,
not a speedup claim;
no performance qualification on battery.

Baseline launcher exited 0; **candidate launcher exited 1** after game-client
SIGKILL and process-group inspection EPERM. Preserve that failure even though
owned groups/ports are now clear. Cameras restored, browsers closed, and the
verified stopped owned database/sole-use volume were removed; assets and evidence
remain. Ten cow-related 404 console errors and six warnings remain, with zero
page errors/request failures. No default promotion, commit or push. Continue
cohesive full-bank refinement, then the original dirt/rock near/mid/grazing and
motion/budget gates.
[Review49 evidence and remaining gates](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review49-UNQUALIFIED/README.md)

**Review50: modest pond-transition refinement; still UNQUALIFIED.** The explicit
`pondBlend=relief-v1` candidate requires the fine-meadow pair and
`terrainBlend=height-v1`. It uses the existing aligned relief maps on the frozen
review49 geometry; defaults, wetness, grass support and access remain unchanged.
**105 material tests and 229 runtime/profile tests pass**, as do shared and
explicit test-inclusive typechecks. The corrected test-only ES2021 failure and
the broader run's two historical **expected-v4 versus actual-v6** fixture
failures remain in the evidence; this is not a fully green repository run.

The actual native close image is valid at the matched review49 camera and
**1280x720, DPR1, MSAA4, post-processing off, seven 1024x1024 maps at 16x**.
Daylight phases are **0.58955883 / 0.58959855**. Main and independent review
agree on modest relief-breakup improvement only; the broad smooth shoreline
collar and uniform lawn remain. Boot **58.924 s** and camera settling
**9.755 s** are observations, not smoothness or performance approval.

**Motion verification did not complete.** An unexpected document reload
interrupted the motion wait and left the world absent. Immediate readmission
then failed `scene_assets_not_ready` after another reload. Five source/build
hashes stayed unchanged, but the reload cause is unproven. **No motion video or
new overview was saved.** Do not infer native stability, mip/shimmer acceptance
or a solved whole shoreline from the successful close still.

The owned browser closed, but **the launcher exited 1** after game-client
SIGKILL and process-group inspection EPERM. Retain that failure despite all five
ports **3333 / 5555 / 5556 / 9236 / 57831** being clear. The verified stopped
owned container
`4931a07c32d9f446e5320a9104fac0d3a363f5422623b7fb1af803e522694a03`
and sole-use volume `hyperia-terrain-pond-review50-data` were removed:
disposable test state only; no source, assets or evidence were deleted.
Power became AC only after cleanup, which does not retroactively qualify
performance.

Next prioritize **whole-pond composition, overview first**, using authoritative
bank geometry, actual asset contacts and habitat layout, not another tiny shader
gain. Original dirt repetition, broader material coherence, motion/mips and
power-stable GPU/frame/loading/memory qualification remain open. No default
promotion, commit or push.
[Review50 evidence and remaining gates](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review50-UNQUALIFIED/README.md)

**Review51: bounded native motion recovered; still UNQUALIFIED.** Production
sources/builds remain unchanged from review50; all five recorded hashes match.
Native Chrome/Metal retains **1280x720, DPR1, MSAA4, post-processing off, seven
1024x1024 maps at 16x**. Boot takes **59.220 s**. Across **15 m 15.222 s** of
observation there is one initial document request, no subsequent document reload
or crash, and HMR remains connected. This does **not** explain or fix review50's
unproven reload cause; its failed evidence remains intact.

The first recording attempt failed because `info.frame` advances before the
actual graphics render. A real **94-call probe** demonstrated that recorder
assumption. The corrected artifact-only recorder requires cumulative
`render.calls` to advance within the actual call and a distinct `info.frame`.
Its **12 s native clip is 11,719,153 bytes**, with **350 decoded frames spanning
0–11.855 s** and **60 distinct world/render/camera poses**, each with actual
render-call advancement and unchanged settings. Recorder-hook, tracks, RAF and
camera restoration are verified. This is recovered visual evidence, not a game
FPS, GPU-cost or long-duration stability pass.

The overview phase **0.58981292** matches review49's **0.58986587** closely.
Independent review finds the overview near-identical: the broad flat collar and
uniform lawn remain. Decoded frames **01 / 06 / 12** show no obvious seam,
square grid or stretching, but do not establish shimmer/mip acceptance or close
the original dirt-repeat gate.

The owned browser closed and camera/16x settings were restored. The launcher
exited **0**, with no forced process-group cleanup; ports
**3333 / 5555 / 5556 / 9236 / 57831** are clear. The verified stopped exact owned
container and sole-use volume `hyperia-terrain-pond-review51-data` were removed:
disposable test state only, with source, assets and evidence preserved. There
are **five cow-404 console errors, zero page exceptions and zero request
failures**. AC power was present throughout, but no GPU/FPS acceptance ran.

The next **whole-pond geometry/contact/layout pass remains a proposal, not an
implementation**. Start overview-first, preserve authoritative terrain and
worker/grass/contact agreement, unchanged water coverage and open fishing
access; do not substitute another small shader adjustment. Original texture,
motion/mip, loading/memory and representative performance gates remain open.
No production-code change, default promotion, commit or push.
[Review51 evidence and proposed next pass](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review51-UNQUALIFIED/README.md) · [Native motion clip](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review51-UNQUALIFIED/candidate-bank-motion.webm)

**Review52 first native attempt: FAILED / UNQUALIFIED; retained history.**
The shared paired western/northern bank profile, six explicit rock X/Z changes
and existing reed-group relocation now have **137 related CPU tests**, passing
builds and zero final test-inclusive typing diagnostics. The original native
geometry/burial failures and wrong-manifest geometry-selection run remain
retained. Corrected terrain adds **4,699 vertices / 9,346 triangles** across two
tested leaves: 8,505 new-shoulder probes peak at **2.73066 mm**, while 361 broader
probes including the unchanged southern control peak at **1.26170 cm**, below
the unchanged 2 cm gate. Actual fixture owners retain **17 rock actors,
32 dressing instances, 69 subjects, 293 approaches, 27 protected southern tiles,
1,300 routes / 105,049 edges, 48 trees and 5 fishing resources**. These are
bounded technical results, not rendered contact, live walking or art acceptance.

Actual headful Chrome/Metal/WebGPU boot passed in **68.742677 s**, retaining
**1280x720, DPR1, MSAA4, post-processing off, seven 1024x1024 maps at 16x**.
The overview camera cut failed after **3.609 s**: grass cell
`gcell_v1_13_11` / node43, an LOD0 swap at X325–350/Z275–300, exhausted the
unchanged **1,000,000 grounding-work** budget. It recorded **114.8 ms active**
against 250 ms and **670,766 resumptions** against 1,000,000. These distinct
counters must not be conflated. This is a deterministic work failure, not a
battery-speed timeout. No grass cap was raised; density, render quality,
terrain detail and texture budgets were not reduced.

**No qualified overview or motion was captured.** `failed-overview-grass.png`
contains HUD and unmatched daylight and is failure evidence, not an art A/B.
A later overly broad diagnostic attempted to return the full `ticket.work`
object; `page.evaluate` reported Target crashed, with the page crash recorded
at **13:51:37 UTC**. Causal attribution is unproven; do not repeat full-work-object
serialization. There are **6 console errors (5 cow-related, 1 grass), zero page
exceptions, one crash and one initial document request/no reload**. Source/build
pins stayed unchanged during the run. CPU/build passes do not override this
native failure or establish GPU/frame performance.

The owned browser closed. The launcher exited **1** because residual game-client
shutdown required SIGKILL; **inspectionErrorCount is 0, with no EPERM this run**.
All five ports **3333 / 5555 / 5556 / 9236 / 57831** are clear. The verified stopped
exact owned container
`18a07de40aca7194838ae2bbb276b87dd4170904b292870dff7a414152c8a478`
and sole-use volume `hyperia-terrain-pond-review52-data` were removed:
disposable test database only, with source, assets and evidence preserved.

The next step at that checkpoint was to fix **deterministic grass grounding work**
under the unchanged caps and quality settings, then repeat the matched native
overview/contact/motion review. Loading/memory, real traversal and stable-power
GPU/frame acceptance remain open. The source goal remains active; no default
promotion, commit or push.
[Review52 failed native evidence and technical scope](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/README.md)

**Review52 native retry: recovered evidence, still UNQUALIFIED.** The frozen
grass correction preserves exact old-oracle outputs while completing all
1,162 clumps / 1,089 retained at **728,531 work units**, below the unchanged
1,000,000 cap. The old exhaustive accounting is 1,106,310 units, not a passing
full job. No density, terrain/texture detail or quality reductions were used.
After fresh builds, all **36 source/test/overlay pins remain stable** through the retry.

Actual Chrome/Metal/WebGPU boot takes **53.604266 s** with unchanged
**1280x720, DPR1, MSAA4, post-processing off, seven 1024x1024 maps at 16x**.
The overview cut now settles in **4.590887 s** with no grounding failure, but
cumulative maximum grass slice **5.5 ms** still exceeds the **2 ms target**.
The initial bank cut settles in **6.715139 s**. Overview and close daylight
phases are **0.58978357 / 0.58952574**. These
matched captures do not establish seamless camera transition or smoothness.

The actual **12 s VP8 canvas clip is 12,384,360 bytes**, with **60 advancing
render/camera samples**. Render hook, recorder, tracks, RAF and camera ownership
were restored. Recording completion is not motion/shimmer acceptance; no
30/60 FPS claim follows from sampled poses or the recording's nominal rate.

The overview's schema2 physical-pass probe validates **484 measured frames**;
there are **3,198 physical segments across the full capture**, including warm-up,
and **2,904 in the measured frames**. GPU-pass union p95 is **19.791872 ms**,
client tick p95 **22.30 ms**, and instrumented CPU tick p95 **10.70 ms**, at
**205 draws / 1,629,043 submitted triangles** per measured tick. This is a
bounded overview sample, not matched old/new cost isolation or 60 FPS approval.
Untimed work, copies, queue idle and presentation are outside the union; observer
overhead is not subtracted. Probe ownership and resources restored successfully.

Current native residency records **504,728 bytes** of edge-index metadata across
**3 indexed surfaces / 52 installed chunks**. JS used heap is **2.266 GB at one
point**, not a trend, leak test or whole GPU/CPU memory budget. The two-leaf CPU
index cost and the initial geometry expansion remain recorded separately.

Main and independent art review find only modest northern-shoulder improvement:
the broad oval dark collar and uniform turf persist. Next use the existing
elevation/slope/relief systems to inspect the pond wetness contour, which applies
to the **whole blended material**, and make a source-informed bank/material
composition pass. This is not another generic anti-tiling adjustment, nor a
proven attribution that wetness alone causes the entire defect. Preserve
shared physical terrain/grass support, resource access and open traversal.

Retry events show **zero crashes, page exceptions or reloads**, one initial
document request and five deferred cow-related console errors. The browser
closed; launcher exit is **0**, with no forced groups or inspection errors.
All five owned ports are clear. The verified stopped exact retry container
`fd765629b7deb255358fc0600878527a40d6dc33296e434e3daf8701b2db3fc1`
and sole-use `hyperia-terrain-pond-review52-data` volume were removed:
disposable test database only. First-attempt grass failure, diagnostic crash
and launcher exit1 remain intact. No default promotion, commit or push.

[Review52 complete evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/README.md) · [Fresh overview](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/candidate-overview.png) · [Fresh bank](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/candidate-bank.png) · [Native clip](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/candidate-bank-motion.webm) · [Motion proof](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/candidate-bank-motion.json) · [Physical-pass proof](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review52-UNQUALIFIED/overview-physical-gpu-summary.json)

**Review53: bounded rock-contact detail, not whole-shore acceptance.** Actual
native layer/cause outputs show soil dominates the dark inner bank despite strong
raw cliff coverage; this does not justify exempting all grass from wetness.
The explicit `pondBlend=relief-contact-v1` inherits relief, then transfers only
final dry-soil weight to existing rock inside the two unequal authored contact
ribbons, constrained by original pond soil, raw geometric cliff and road priority.
Grass/coastal weights, wetness, geometry, navigation, fishing access, root colors
and density stay unchanged. Positive grass-support/contact overlap remains a
native color/contact gate; unchanged grass weight does not prove visual agreement.

**354/354 focused tests**, ordinary shared and explicit three-test types, and
fresh shared/server builds pass. All **39 source/test/overlay pins** stay stable
through builds and native review, with all eight build pins stable afterward. The selected material retains seven
1024x1024 maps at 16x and 33 surface samples; actual control/candidate normal
shaders both contain 53 `textureSample*` sites and no `textureLoad` calls.
No texture-read increase, quality reduction, default promotion, commit or push.

Actual headful Chrome/Metal/WebGPU uses **1280x720, DPR1, MSAA4, post-processing
off** on AC. Candidate boot is 63.201 s and overview cut settling 4.910 s, not smooth
startup/camera approval; cumulative maximum grass slice 11.8 ms still exceeds the
2 ms target. Matched overview/contact daylight images reveal small coarse bank
detail beneath the reeds, but do not connect the land rocks convincingly through
the green apron or remove the oval collar. The southern bare-bank image retains
a soft turf feather. The fresh coastal view retains repeated-looking cracks,
elongated mottling and a broad green fade; it is **not matched to an older A/B**.

The actual 12 s moving contact clip has 61 advancing render/camera sample receipts
and restored recorder/RAF/render-hook/camera owners. Decoded stills show no
obvious hard-mask seam, but vegetation obscures roots; complete temporal shimmer,
mips and motion acceptance remain false. **Near → gameplay → stream distance →
return**, original bare-bank dirt, coastal rock/soil, path joins and grass-root
agreement all remain unqualified.

Separate nighttime physical-pass windows cover 490 control / 483 candidate frames.
Observed GPU-union p95 is 19.791872 / 19.726336 ms and client-tick p95 is 22.5 / 23.1 ms,
but submitted triangles differ 3,398,477–3,398,509 versus 3,490,365, with separate
agent/wind state. These are not isolated material cost, a speedup or 60 FPS
acceptance. Untimed work/presentation and observer overhead remain outside those
claims. No general loading/memory or sustained performance gate is closed.

The first control's server-not-ready initialization failure and later control
launcher exit 1/SIGKILL cleanup remain preserved. Candidate events contain zero
crashes, page exceptions or reloads, one initial document and five deferred
cow-related errors, with zero request failures. Its browser is closed; camera
and render hook are restored, with all seven filters still 16x. Candidate launcher
exits 0 with no forced groups or inspection errors; all five owned ports are
clear. The verified stopped exact candidate container and sole-use
`hyperia-terrain-pond-review53-data` volume were removed: disposable test database
only; source, assets and evidence remain. The control's failed cleanup is not
overwritten by this clean candidate shutdown.

Next: attribute the **coastal shoulder** with actual final-layer/raw-cliff/normal
outputs, then cover path joins, accepted grass roots and moving texture distance
before another pond-only refinement. Keep current settings and open traversal;
do not enlarge this local mask or add foliage merely to hide remaining defects.
[Review53 scope and evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review53-UNQUALIFIED/README.md) · [Matched overview](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review53-UNQUALIFIED/candidate-overview-daylight.png) · [Close contact](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review53-UNQUALIFIED/candidate-contact-daylight.png) · [Bare bank](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review53-UNQUALIFIED/candidate-bank-daylight.png) · [Current coastal coverage](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review53-UNQUALIFIED/candidate-coastal-rock-bank-daylight.png) · [Native contact clip](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review53-UNQUALIFIED/candidate-contact-motion.webm) · [Observation ledger](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-pond-review53-UNQUALIFIED/observations.json)

**Review54: valid technique, negligible visual payoff; rejected as a fix.**
Actual native layer/cause outputs identify a rock-dominated coastal face with a
mixed grass/rock shoulder and no inland pond contribution. The normals output
is the final blended view-space material normal, not geometric normals alone.

Explicit `coastBlend=detail-v1` reuses aligned, already sampled grass height as
endpoint-preserving coverage detail, not physical rock height. All PBR channels
share the final grass/rock-branch weights; full roads and the full pond radial
region are excluded. Explicit soil weights stay fixed, but soil nested in the
coastal rock branch can change. CPU grass placement, root colors, geometry,
traversal and default selection remain unchanged. Unchanged grass ownership
does not prove root-to-ground agreement. The experiment remains opt-in only.

**388/388 focused tests**, ordinary shared and explicit test-inclusive types,
and fresh shared/server builds pass. The same seven **1024x1024 maps at 16x**
retain **33 surface reads**; both actual normal shaders contain **53
`textureSample*` sites**. No texture repacking, additional texture reads,
density/detail reduction or default promotion was used.

Matched headful Chrome/Metal/WebGPU captures use **1280x720, DPR1, MSAA4,
post-processing off** and unchanged camera/terrain. Wide daylight phases are
**0.4998439 / 0.4998224**; exact near phases are
**0.4995642024 / 0.4995562854** (control/candidate). Main and independent review
find at most subtle grain breakup: the broad airbrushed border, brown elongated
rock features and muddy grass transition remain. Approximate decoded motion
frames are not exact A/B pairs or proof of temporal stability. Both native
12-second clips restore their owned recording/camera hooks; successful
recording does not close shimmer, mip, root-contact or distance-return gates.

Physical-pass GPU-union p95 is **25.690112 / 27.19744 ms**. Submitted geometry
matches, but separate dynamic scenes and bounded windows do not isolate shader
cost or establish a regression/speedup. Neither result is 60 FPS approval; union
timing excludes presentation/untimed work and does not subtract observer cost.
Loading, memory, smooth camera cuts and sustained performance remain open.

The initial control HUD/cursor-restoration rejection, backward-phase wait
rejection and corrected test-fixture failures remain preserved. Owned native
browsers/hooks are restored or closed; launchers exit 0, all five owned ports are
clear, and verified stopped disposable database containers/sole-use volume are
removed. Only disposable test data was removed; source, assets and evidence
remain. Clean shutdown does not supersede historical failed runs.

Next: use actual spatial material/root evidence to distinguish the broad
shoulder's composition/scale problem from the rock source's interior appearance,
then choose a materially different correction rather than another mask-gain
loop. Cover paths, original bare-pond dirt, grass roots, water-edge response and
near → gameplay → stream distance → return before accepting whole-world textures.
No quality gate is newly checked; no default promotion, commit or push.
[Review54 verdict and evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/README.md) · [Wide control](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/control-coastal-daylight-recheck.png) · [Wide candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/candidate-coastal-daylight.png) · [Near control](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/control-coastal-near-daylight-recheck.png) · [Near candidate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/candidate-coastal-near-daylight.png) · [Control motion](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/control-coastal-motion.webm) · [Candidate motion](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/candidate-coastal-motion.webm) · [Observation ledger](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/terrain-coast-review54-UNQUALIFIED/observations.json)


## Current work — preview44 connected pond habitat; UNQUALIFIED

**World first; avatar/armor later. One arena, SOL only.** Root and independent native-image review retain preview44 over43: shoreline groups connect better and fishing cues read as water disturbances. This is a visible improvement, **not AAA or production acceptance**.

- [x] Add two unequal dry-soil contact ribbons using existing PBR maps/noise; closer 32-instance pond planting preserves five models, underwater rock guards and southern access. Physical wetness, terrain and grass eligibility remain unchanged. The broader material gate (v6 + southernMeadow) and sector-dependent dressing gate are explicitly documented.
- [x] Create an explicit unqualified overlay moving/rescaling 13 existing pond landscape rocks. Keep IDs/variants/yaw, all four workshop rocks and every other world setting unchanged. Three initially over-buried satellites were corrected explicitly; failed evidence remains. Frozen world20/defaults stay untouched.
- [x] Replace candidate blue fishing coins with a soft desaturated cue: same clickable disk, interaction metadata, depletion/respawn and existing particle pools; no new texture/mesh. **123 focused material/dressing/fishing checks pass** (104 + 19); candidate fishing cases also pass under the overlay. Shared types and shared/server builds pass.
- [x] Exact-overlay support/navigation checks: **17 actual PhysX actors/shapes, 65 occupied tiles, 1,299 support samples; 69 land resources/stations, 293 approaches, 27 preserved southern shoreline tiles; 1,300 routes / 105,049 valid edges** plus outer-pond circulation. The fixture invokes the real authoritative walkability bake; it is not server-startup or native walking proof.
- [x] Native WebGPU preview: **48/48 tree owners/proxies, 56/56 pond/service instances, 17 rock placements**, both agents and five interactive soft fishing cues. Corresponding43/44 cameras/settings match; natural daylight is very close, not identical. Both HUD captures and final awaited camera/observer cleanup succeed. Owned browser/services/disposable databases retired; source/media preserved.
- [ ] Resolve the retained native rock-ray discrepancy: **0.907 mm normal-to-surface error vs unchanged 0.244 mm bound** at a buried north-04 face. The broader exact-overlay ray suite is not green; no tolerance or placement was changed to evade it. Stream-client occupancy alone does not prove server physics.
- [ ] Fix grass preparation/LOD latency: final94 chunks /84,515 clumps, zero failed/cancelled queues, but wide/return settling **12.891 s /5.716 s**, cumulative max slice **6.3 ms >2 ms target**. Passing the diagnostic30s cap is not smoothness or performance approval; prior grounding failures stay open.
- [ ] Next art batch: natural path shoulders, continuous dark pond lip/bright lawn cuff, grass/terrain color and scale integration. Preserve open traversal and resource/fishing readability.
- [ ] Qualify motion/shimmer, real walking/interaction, repeated LOD returns, loading/memory, target-hardware frame cost and sustained gameplay/streaming before launch.

Five known cow/404 console errors remain; zero page/capture errors in44. No exhaustive GPU-cost trace, production/default promotion, commit or push. Initial failed placements, diagnostic fixtures and all older checkpoints remain visible.

[Preview44 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-preview44-UNQUALIFIED/README.md) · [Preview43 intermediate](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-preview43-UNQUALIFIED/README.md) · [Current details](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)

## Prior checkpoint — preview42 physical pond contacts; UNQUALIFIED

**World first; avatar/armor later. One arena, SOL only.** The saved references remain the target. Root and independent review retain the asymmetric pond shape as a **modest improvement, not cohesive AAA art or production approval**.

- [x] Add two optional northern shelf/shoulder sectors to the existing shared physical surface. Preserve the southern fishing approach, bed, outer envelope and existing elevation-driven soil/wetness/grass owners. Frozen world20 and defaults remain unchanged; the candidate is an explicitly unqualified asset overlay.
- [x] **126 unique tests pass across seven files** (108 + 18), plus the final retained-mesh case rerun **1/1, 37 skipped**. Shared types, development shared build and ordinary server build exit 0. No full source/world/native qualification was run.
- [x] Final actual-game daylight pair shows loaded/rendered sectors, **48/48 tree owners/proxies**, **94 grass chunks / 84,389 clumps** and zero grounding queues. A warm bank→pond return settles in **482.828458 ms**; this is one preview observation, not a performance/reliability pass.
- [x] Preserve the rejected expanded 9 m refinement and its **two terminal `grounding_work` failures**. Restore the existing 7.9 m annulus without changing budgets, base grid or grass density. The corrected session has no observed grounding failures, **not a causal fix for native39's separate `active_cpu` failures**.
- [ ] Resolve the precision/performance tradeoff: restored annulus avoids **19,272 triangles**, with sampled outer-bank height error **1.2543 cm** but normal error **5.639° versus 2.207°** for the expanded annulus. Cumulative grounding slice **6.7 ms exceeds the 2 ms target**.
- [ ] Improve shore substrate/contact dressing, the continuous rim and bright turf cuff, detached plants/rocks, natural path shoulders and meadow/ground scale/color integration. Preserve free traversal and resource/fishing access.
- [ ] Qualify motion/shimmer, repeated LOD returns, walking, loading/memory, target-hardware frame cost and sustained gameplay/streaming before approval.

Use the final `bank-asymmetric-day.png` / `pond-asymmetric-day.png` pair only for current art review; both restore HUD ownership. Earlier failed-grounding/HUD and mismatched-light images remain debug evidence. Five cow/404 console errors remain, zero page errors; no exhaustive GPU-warning or cost trace was collected. Owned sessions/observers retired and the verified disposable database/sole-use volume were removed. Startup-manifest rejection, earlier failures and all prior checkpoints remain preserved; no default promotion or qualification claim.

[Preview42 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-preview42-UNQUALIFIED/README.md) · [Current details](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)

## Prior checkpoint — preview41 canopy/startup improved; UNQUALIFIED

**World first; avatar/armor later. One arena, SOL only.** Continue using the saved grass/bank images, supplied portfolios and primary Three.js examples. Root and independent review favor retaining the canopy candidate, **not AAA visual acceptance or production approval**.

- [x] Implement explicit fine-meadow upper-leaf widening/quadratic taper and reduced root darkening. Preserve roots, tips, centerlines, normals, topology and instance settings; retained clumps and raster cost can change.
- [x] Final focused runs: **36 Appearance + 31 Wind + 102 Grounding + 37 Generation + 183 runtime-policy = 389 passing tests**. Shared `tsc --noEmit` and development build exit 0. Archived geometry hashes remain exact; this is **not fresh full source/world/native qualification**.
- [x] Fix a real tree-startup race: the deferred pool setup left **27 of 48 trees** without rendered owners/proxies despite no pending pool work. Initialize against Stage's existing Scene before asynchronous world/resource registration. **Two successive reloads show 48/48 actual owners and attached proxies**; this does not prove every reconnect scenario.
- [x] Review two complete-scene native WebGPU images. Connected green volume improves and isolated dark stems reduce. Earlier night/stale-bundle/missing-tree images remain debugging evidence, **not valid complete-scene art A/B**.
- [ ] Improve asymmetric physical pond contacts, soil/grass integration, bright lawn collars, smooth paths, uniform olive coloration and disconnected dressing. Preserve fishing access, free traversal, water coverage, collision/worker agreement and resource ownership.
- [ ] Freeze a visually credible batch, then run complete source/world/native qualification plus motion/shimmer, LOD return, walking, loading/memory, representative frame cost and sustained gameplay/streaming.
- [ ] Keep native39's two grounding-budget failures open; absence in this lightweight, nonmatched preview is not a causal fix or reliability proof.

**Evidence scope:** preview41 used the existing isolated development launcher and world20 manifests. No new qualification receipt/world derivation or default promotion. Across six loaded documents it retained **30 console errors** (24 cow-specific + six generic 404s), with no observed page errors or grounding-failure messages; exhaustive GPU-warning and frame-cost evidence was not collected. No gear suite, motion, walking or endurance test ran. Camera/HUD/observer ownership was restored, browser/services retired and only the verified stopped disposable database/sole-use volume removed.

Candidate39/world20/replay53/native40 remain historical evidence for their frozen source, not qualification of these later changes. All earlier errors, rejected images and native40/native39 history remain intact.

[Preview41 evidence](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-preview41-UNQUALIFIED/README.md) · [Current details](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)

## Prior checkpoint — native40 bank-first review complete; visual acceptance remained open

**World first; avatar/armor later. One arena, SOL only.** The saved grass/bank images, portfolio projects and primary Three.js examples remain the targets. Native40 shows a modest local improvement, **not accepted art, AAA quality or production qualification**.

- [x] Share three connected service-approach wear ribbons between soil composition and vertical grass/wind/grounding scale. Keep root eligibility, building clearances, navigation and defaults unchanged. Seven physical maps / **27 ground gradient reads**; no measured cost claim.
- [x] Candidate39: **1,495/1,495 in 72 files**, zero semantic diagnostics and both builds; **181 current pins** verified. World20: derive/fresh verification **9/9 each**, **192 pins / 41 unchanged manifests / 15 direct original-asset links**. Replay53: **467/467**, all 31 pins verified. Earlier failed tests and runs remain.
- [x] Native40: exactly **three 1280×720 bank/campus/pond views**, with completed focused coastal and bank-review admission. All **917 source pins / 821 executed archives / three PNG hashes** independently verified.
- [x] Add bounded grounding-failure context without raising budgets. The required pond hold lasted **60,008.97575 ms**, including **5,871.584292 ms** settling. Natural daylight then added **167,335 ms**; actual pond-pose-to-photo exposure was **226,909.4 ms**, with no grounding errors. This is **not a fix claim** or matched-condition proof against native39’s ~239-second pond wait.
- [x] Review all three images: the local apron improves modestly, but thin dark stems, a bright uniform lawn, smooth collars and regular pond contacts persist. **Visual acceptance remains open.**
- [ ] Next: materially improve meadow-wide upper-blade silhouette, root shading and substrate integration, retaining shared wind/normal/grounding correctness and explicit performance budgets.
- [ ] Then improve asymmetric pond contacts and surrounding composition without sacrificing free traversal, resource/service access or ownership.
- [ ] Keep native39’s two grounding-budget failures open until diagnosed and tested with representative exposure; absence in this nonmatched run does not erase them.
- [ ] Qualify motion/shimmer, LOD return, walking, loading/memory, balanced frame cost and sustained gameplay/streaming after the art direction is credible.

**Faster iteration:** use the existing isolated launch helper, development client and shared-build reload for explicitly **UNQUALIFIED development previews**. Reuse existing cameras; do not bypass source-pin checks or label previews as receipts. Freeze a credible art batch before complete qualification and fresh native evidence.

Native40 remains **overall/study=false, exit 1**, with **19 retained console errors** (14 dagger-fit, four cow-specific and one generic 404); GPU/page/cleanup errors are empty. No clips, motion, walking or cost probe ran. Browser/services retired; only the verified stopped disposable database and sole-use volume were removed. All media/source evidence remains. Native39’s failures, native38’s rejection and all older history remain intact. No default promotion or production approval.

[Current details](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)

## Prior checkpoint — native dirt comparison improved; motion and cost remained open

**Compact island/world first; avatar and armor later.** One arena, SOL only.
The user's grass/bank images, portfolio references and primary Three.js examples
remain the art direction. Source checks are not AAA visual acceptance.

- [x] Wire explicit `dirtProjection=stochastic-v1` only into the admitted fine-meadow stream preview with compact sculpt terrain; capture selection once before material creation. Reject duplicate/incompatible options. Absence keeps the original 20-read material; the candidate uses 22 reads and the same six maps.
- [x] Candidate35: **1,449/1,449 tests in 72 files**, ordinary semantic check **735 roots / 2,378 files / zero diagnostics**, shared/server builds. Independently verified all **179 source pins / 61,815,920 bytes**, before/after equality, qualifier, command logs and test JSON.
- [x] World17: derivation and fresh verification **9/9** each; all **41 world16 manifests** remain byte-exact. Independently checked 190 source pins and inherited proofs. Fifteen verified directory links reuse original assets; no asset copies or default promotion.
- [x] Research application: triangle-patch stochastic sampling, explicit gradients and mip/contrast risks informed by Heitz/Neyret, Unity's published implementation and primary Three.js WebGPU terrain/filtering examples. Our linear-albedo compensation is approximate, not full histogram preservation.
- [x] Replay46 **406/406**; all 27 source pins unchanged and independently verified. Replay45's three stale test expectations were corrected; its failed receipt remains intact.
- [x] Capture native32 control and native33 candidate on the same current source/world. Independently verify each run's **915 source pins, 819 executed archives and seven PNG hashes**. Actual compiled control/candidate shaders use **20/22 reads**, respectively, with paired dirt maps sampled twice/three times.
- [x] Compare stills: the regular pale rows/dots are reduced; near-bank pebble detail and close rock definition remain. Independent review favors the candidate for further qualification, but calls the improvement modest. Broad mottling, soft green borders and artificial path shapes remain.
- [x] All seven camera/settings pairs match. The first five views pass before/after natural-light matching; **bank and campus exceed the unchanged 0.003 phase tolerance** and are not matched-light color evidence.
- [ ] Accept the dirt fix only after bank texture detail, color, seams, oblique filtering, motion/shimmer and representative frame cost are demonstrated.
- [ ] Then continue grass LOD convergence/fullness, natural paths, landform/ground/water cohesion, resource-linked vegetation and freely traversable open ground.
- [ ] Full traversal, loading, memory, frame-cost, long-duration gameplay/stream and overall visual acceptance remain open.

Candidate35 receipt SHA256:
`e0630269a7a55e9b3e4c21fcdbc6075a4ee3acc19a37bda10d2caa2f4cfd9eac`.
World17 receipt SHA256:
`5645a638d417b1af31ec173d9e8693e5f527ffaae4b2fd52919aa47e757b62cf`.
Native33 capture completed with zero GPU/page/study/cleanup errors and launcher
exit 0. Both runs retain the same 19 console errors (14 dagger, four cow-specific,
one generic 404); overall approval remains false. Native32's overall run also
failed client shutdown (SIGKILL required, then EPERM inspection), despite complete
capture admission and eventual process/port cleanup. Neither failure is waived.
No motion, traversal or GPU-cost measurement was performed. The two exact stopped
disposable test databases were removed; all evidence and original assets remain.
No production/default approval, commit or push.

Native32 report SHA256:
`da34e2d299f5f59464ffeb242e01652c2cbe458e3d075f3759e2176212d7fd15`.
Native33 report SHA256:
`9f04242a5e9f335650761ef603bf1809644216bb5fbf243c29fbad4c0f472e71`.

[Current details](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)

## Prior checkpoint — dirt candidate source qualified; native art/performance acceptance remains open

**Compact island/world first; avatar and armor later.** One arena, SOL only,
no large-island preservation requirement. The user's fine-grass image, supplied
portfolios, Rainy Worlds and primary Three.js examples remain the visual targets.
Bruno's grass source guides shared ground/blade color and spatial variation,
not camera-facing geometry or hidden performance compromises.

- [x] Candidate34: **1,440/1,440 tests in 72 files**, ordinary shared semantic check **735 roots / 2,378 files / zero diagnostics**, shared/server builds. Independently verified all **179 source pins / 61,802,510 bytes**, before/after equality, qualifier source, four command logs and tests JSON.
- [x] Historical candidate33/world16/v14 qualified the native31 checkpoint. Three material/test files have since changed; those old receipts do not admit current source or a new candidate preview.
- [x] Implement explicit optional `compactDirtProjection: "stochastic-v1"`: dirt-only three-patch triangular projection, signed PCG hash, paired gradients and approximate linear-albedo variance compensation. It is **not wired into live TerrainSystem selection or enabled by default**. Source surface-read budget is **22 instead of 20**, not measured GPU cost.
- [x] Native29: all seven world views and actual mask/root storage proof for 16 submitted pipelines within the eight-vertex-buffer limit. Native28's unsettled-queue/shutdown failure remains retained.
- [x] Qualify the separate opt-in dirt diagnostic: Replay43 **392/392**, all 27 pins unchanged; original 15-second coastal daylight gate retained, separate bounded 30-second diagnostic gate verified.
- [x] Native31: seven ordinary views followed by five same-camera, naturally daylit dirt trials on actual Apple Metal/WebGPU. All **917 then-current pins / 821 executed archives / 12 PNG hashes** independently verified; zero GPU/page/device errors. Diagnostic completed in **2.632 seconds**, with exact original graph, shader and native texture bindings restored before temporary-resource disposal.
- [x] Review all five dirt images: reusing the existing **0.006 meadow selector is insufficient**. No trial is accepted as the finished material; preserve this negative visual result.
- [ ] **Current user priority: remove the visible dirt-bank grid.** Source qualification is complete, but explicit isolated preview selection, fresh detached-world admission, native original/candidate bank comparison, motion and actual cost checks remain open. Preserve soil detail, paired normal gradients, world anchoring, geometry and free navigation. No stochastic-candidate native capture exists yet. Complete this before the grass-width trial.
- [x] Correct the future exact opt-in fog-capture inventory: **87/87 focused + 5/5 targeted checks** passed. Native31 still retains its immutable **12 != 7** failure; qualifying the future inventory does not relabel that run.
- [ ] Fix camera-driven grass LOD convergence. Native31 cut-to-settled times: **6.05 s bank / 7.66 s campus-link**. Its recorded **5.9 ms maximum slice is cumulative and already present at initial readiness**, not a newly measured cut-specific overshoot; the existing 2 ms preparation target remains open. Diagnostic waiting is not seamless-transition acceptance.
- [ ] Fuller meadow: isolated width **0.045 → 0.060** trial, then coherent height/color patches and terrain/blade integration. Hold population, height, wind, lighting and cameras during the width test; inspect motion and actual cost.
- [ ] Improve the larger composition: irregular natural path shoulders/arrivals, varied coastal landform and rock contacts, richer ground textures, pond/ocean integration, resource-linked vegetation and freely traversable open ground.
- [ ] Complete motion, traversal, LOD-return, loading, memory, frame-cost and long-duration gameplay/stream acceptance. No default promotion or AAA/production approval.

Native31's overall exit remains **1**, with `coastalCaptureCompleted=false`:
its only cleanup assertion is **12 != 7** in fog-screenshot inventory. The
observer itself restored, all 12 observations completed without errors, and the
separate dirt diagnostic completed/restored successfully. Five cow-404-related
console errors and 14 known dagger-fit errors also remain; full gameplay,
movement, cost and native lifetime qualification were not performed. These
deferred assets stay open, not silently accepted as production success.

Replay44 remains **364/394, exit1**: all 30 failures stopped at the same strict
stale candidate33/world16 source-pin gate. They are not assumed passes; the
harness still needs fresh candidate/world admission. No gate was weakened.

Candidate34 receipt: 107,285 bytes, SHA256
`61bfca700a5b846ec27e6d23fb157badbae96cf358fed6290f97d34a2c420e66`.
Native31 report SHA256:
`f0769acedf72d8ff4d2c2fc6e469ccb62b5923f45e6100c646faef90603e5948`.
The source verification describes that run's frozen checkpoint, not any later
anti-tiling edits. All historical reports, source archives and images remain.
Owned browser/services closed cleanly (launcher exit0); only the exact stopped
native31 disposable database container and sole-use volume were removed after
identity checks. No user database, original asset or source was deleted.
No production material/default was adopted from these trials. No commit or push.

[Current details](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)

## Prior checkpoint — worn-turf source and shader verified; full visual review pending

World first; avatar/armor remains deferred. The current material pass follows the
original fine-grass reference, Three.js terrain boundaries and the saved portfolio
references. It shares irregular wear between terrain and grass-root color without
changing map geometry, navigation, grass placement or density.

[Detailed evidence and remaining work](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)

- [x] Candidate20: **1,288/1,288**, zero type diagnostics, both builds; 177 pins verified.
- [x] World09: separate fresh startup, 188 pins, 41 unchanged manifests, 15 resource links.
- [x] V7 harness plus bounded failure diagnostics: **276/276**, 21 unchanged pins.
- [x] Real workers preserve default/placement behavior; no new material texture assets.
- [x] Native18's saved compiled terrain shader retains the same 40 sampling sites and 14 texture owners.
- [ ] Complete seven-view visual review; native18 produced only the shoreline-low image.
- [ ] Resolve native17's unproven ownership/maintenance rejection; its failure remains retained.
- [ ] Resume GPU testing only under stable, awake, adequately cooled host conditions.
- [ ] Verify natural path/ground appearance, movement, shimmer, LOD return and free navigation.
- [ ] Meet representative frame/loading/memory budgets and the full world art acceptance bar.

Native17 failed before world capture with 409 and two cleanup errors. Native18
passed both bots' setup but exceeded its deadline after the first photo. macOS
records 985 seconds of Thermal Emergency Sleep during that run; it is not a valid
performance or full visual result. No power/sleep safety control was bypassed.
GPU-heavy runs are paused while saved evidence/source review continues.

The compiled shader observation proves a finite source-level sampling bound,
not equal hardware cost. No path-quality, AAA, default or production approval.
Native16 remains the latest completed seven-view baseline; failed17/18 are not
retrospectively approved. Earlier density-comparison caveats remain.

## Earlier checkpoint — native16 bank views captured; visual refinement still needed

[Current implementation and evidence](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/world-paths-coverage01.md)
uses our saved portfolio/Three.js references and original fine-grass reference.
World remains first; avatar/armor work stays deferred. Three hooked platform
arrivals now use gradual curves. An explicit single-cell 0.60 m grass trial
retains 0.70 m everywhere else; the failed 0.50 m attempt is preserved and its
obsolete selector rejected. No safety budgets or blade shapes were relaxed.
The new bank candidate narrows three shoulders and adds two bounded unequal
wear patches. Native16 now captures this source through the exact v6/world08
selector. Bank/campus views show a small shoulder change, but stamped-looking
brown wear and uniform green turf remain; this is not full visual signoff.

- [x] Fresh bank candidate19: **1,281/1,281 tests**, zero type diagnostics, shared/server builds.
- [x] Independently verify all 177 source pins and command logs.
- [x] Detached world08: 35 groves, 21 supports, 23 paths/577 segments; 188 pins verified.
- [x] Verify 41 unchanged manifests and 15 original-asset directory links.
- [x] Qualify v5/world07 and optional trial admission: **257/257 harness checks**.
- [x] Capture and review seven world views and the first dedicated grass baseline.
- [x] Complete a real native GPU window, target-buffer checks and exact camera restoration.
- [x] Capture the 0.60 m cell candidate and return baseline under identical isolation.
- [x] Requalify all three saved probes; detect off-camera LOD/residency drift in strict comparison.
- [ ] Establish strict comparison acceptance; retain scene differences and native14 shutdown failure.
- [x] Qualify localized bank-shoulder/wear source: 23 paths/577 segments; same 256 mask.
- [x] Derive world08 and verify separate fresh startup; all 41 manifests match world07.
- [x] Qualify v6/world08 through replay19: **267/267 harness checks**, 21 unchanged pins.
- [x] Capture native16's seven world views and inspect its bank/campus approaches.
- [ ] Refine shared wear/turf materials against the saved portfolio/Three.js references.
- [ ] Verify motion/LOD return, free navigation, frame hitches and target-device performance.
- [ ] Refine painted path shoulders, uniform ground coverage and artificial pond margins.

**No art, full-performance, gameplay or AAA approval.**

[Replay18](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/equipped-lighting-replay18.json)
remains a failed receipt: three current-path tests still selected stale v5/q18
sources. Only those test references/admissions were corrected; runtime readiness
gates were unchanged. [Replay19](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/equipped-lighting-replay19.json)
then passed all 267 checks with 21 unchanged pins.

[Native16](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-native16/report.json)
is terminal **exit 1**, despite seven completed world photos and
`coastalCaptureCompleted: true`. There was no new grass probe or density trial.
The staged diagnostic remains incomplete. All five cow and fourteen dagger
errors are retained; page, GPU and cleanup error arrays are empty. The browser
closed, the launcher exited 0, and owned PIDs and ports were absent afterward.
The primary and independent reviewers verified 912 current pins (410,354,741
bytes) and 816 source archives (333,256,088 bytes). The original report remains
58,230,324 bytes, SHA256
`9ee4ec5c4a1e0442081991df54776d94930970fce18af6c9c8ac482830583707`.
Seven PNGs, fourteen RGB/pond boundaries and seven fog/HUD records were also
independently checked. Bank/campus camera poses match native15, but maximum
phase deltas 0.004175/0.005496 exceed the existing 0.003 limit: this supports
morphology review only, **not matched-light or color proof**. No cost, motion,
free-navigation or target-device performance acceptance follows from these stills.

[Native follow-up and evidence](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/grass-native-isolation01.md):
native13/14/15 each complete their separate grass probe and eight image purposes.
Target counts are 1,269 / 1,722 / 1,269. Native14's later launcher EPERM remains
a failed cleanup and its outer coastal-completion flag stays false; native15
restores and closes cleanly. All full runs retain the missing-cow errors and
separate dagger-fit blocker. Baseline13 has two extra non-grass meshes, so the
raw timings are not a density performance win. Source identity was independently
verified before the next bank-path edit. The saved comparison also rejects
non-target grass/LOD and resident-buffer differences, including two off-camera
cells in native14 versus15. Actual grass images remain too coarse
and strongly shadowed relative to the references. No density default is promoted.
Native11's reload and native12's incorrect expectation remain failed receipts.
The detailed checkpoint supersedes current-status statements below; older
receipts are preserved, not reclassified as proof of the new source.

## Earlier checkpoint — path joins and pond detail

World work comes first; avatar and armor work remain deferred. These are
completed source checks, not new native art or performance acceptance.
The earlier checkpoints below remain preserved as history.

- Paths pass **18/18** focused checks. Three platform joins bring the selected
  network to **515 segments**, ten more than before, with the same **262,144-byte
  mask**. The measured lodge residue is **7.81564e-7**, bounded by **1e-6**;
  it is not zero.
- [Adaptive pond checks](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/pond-annulus-adaptive-geometry03.log)
  pass **37/37**, including 2,304 contours, 13,440 bank probes and all six
  asymmetric seams. Maximum radial error is **0.010425 m**; maximum full-bank
  vertical error is **0.006154 m**. Two leaves add **2,278,096 buffer bytes**.
  This is a geometry cost, not GPU performance approval. The candidate requires
  resolution 128; unsupported 64 and 32 cases fail closed.
- [Pond detail retention](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/pond-detail-retention-focused01.log)
  passes **9/9**. The 20 current planner layouts add no base-LOD geometry;
  the annular buffers above are a separate cost.
- [Precompile checks](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/pond-precompile-focused02.log)
  pass **28/28**. Startup now selects the admitted detail resolution for its
  sample rectangle instead of using streaming resolution 16 inside the pond.
  Original caps, cancellation and cleanup checks remain.
- [Integration04](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/annular-pond-integration-focused04.log)
  preserves the broad-travel checks across **7,082 cells**: maximum retained
  gap **0.014625 m** and angle **7.74262°**. Its expected-hash failure remains
  recorded; the golden was updated only after the full byte-level parity proof.

[Candidate17](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/southern-meadow-candidate17.json)
**passes 1,202/1,202 tests across 71 files**. Shared types have zero diagnostics
across 724 roots and 2,364 source files; shared and server builds exit 0.
All 177 source pins and command logs were independently reverified.
[Candidate16's failure](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/southern-meadow-candidate16.json)
is retained: all tests passed, but two typing errors stopped its builds.
Those corrections did not change runtime behavior.

[World06](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/southern-meadow-world06/receipt.json)
passes detached derivation and separate fresh-process verification.
All 188 detached pins were independently checked; the world has 21 supports,
18 paths and 35 materialized groves.
[Asset delivery is complete](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/southern-meadow-world06/ASSET_DELIVERY.md):
15 resource links are verified and all 41 manifests are byte-identical to world05.

[Replay13](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/equipped-lighting-replay13.json)
passed **228/228** in 32.027 seconds.
The latest [replay14](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/equipped-lighting-replay14.json)
passes **232/232** in 31.643 seconds. Both exited 0 with eleven unchanged pins;
the latest full log and pins were independently reverified. The v4 passive
per-photo daylight alignment now has CPU, archival and source checks.
It retains the original 15-second batch and all comparison limits.
**Native10 has finished with all seven world photos saved, but overall exit 1.**

- [x] Finish fresh source, type and build qualification.
- [x] Derive the detached world and verify a separate fresh startup.
- [x] Complete asset-link delivery checks.
- [x] Qualify the v4 harness through replay14.
- [x] Complete and inspect the seven-view native still capture.
- [ ] Qualify natural path joins, pond shores and wider world art.
- [ ] Verify camera motion, open-ground travel and measured performance.

[Native09 is preserved as a partial, exit-1 capture](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-native09/verification.md):
four of seven photos were saved. The pond daylight delta was **−0.0031587**,
outside the unchanged **±0.003** limit. Its 908 current source pins,
812 archives (**333,071,882 bytes**), four PNGs and eight pond boundaries
were independently checked. Browser and stack closure were verified and four
ports were clear. The missing supplemental photos remain recorded by fog
validation; this is not a complete capture or a cleanup-leak claim.
The original report and study are intact; source and geometry remain qualified.

[Native10 verification](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-native10/verification.md)
records all seven PNG hashes and dimensions, exact study/report equality,
908 current pins and 812 archives (**333,083,799 bytes**) independently checked.
All four passive daylight alignments completed and released within the original
15-second batch. Page, GPU and cleanup error arrays are empty. The browser
closed, launcher exited 0 and was absent, and no stack groups remained;
owned processes were absent and four OS ports were clear.
Five unexpected cow404 errors drive the overall exit 1. The 14 dagger-fit
messages remain a separate, deferred blocker. Both ten-second RAF windows
completed but remain unqualified; they are not a performance benchmark.

[All seven native10 stills were reviewed](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-native10/visual-review.md).
Platform gaps are closed, but the new short, hooked joins still look artificial.
The pond is smoother but retains a regular oval and uniform wet rim.
Sparse ground cover, the broad lawn, cove and sky quality remain open.
[Native08's earlier review](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-native08/visual-review.md)
and the failed native09 daylight comparison remain history.
Cow-placeholder work stays deferred. **Completed still inspection is not art,
camera-motion, traversal or performance approval. No default is promoted.**

Next proposed ground-cover trial, **not implemented**: use 0.50 m instead of
0.70 m clump spacing in just one admitted 25 m meadow cell, retaining slender
blades. This can raise candidate population and associated work by about
**1.96×** (1,276 to 2,500 attempts); budgets must remain unchanged.
Compare a fixed-count width trial against the user's fine, overlapping grass
reference. Wider blades may become coarse strips; denser blades can increase
raster overdraw. Neither unchanged counts nor passing placement caps establish
acceptable fragment cost or performance.

The existing [Ameen and Jaime mapping](/Users/lucid/Documents/hyperia/hyperia-implementation/docs/graphics-reference-library.md#user-supplied-portfolios),
[official Three.js terrain references](/Users/lucid/Documents/hyperia/hyperia-implementation/docs/graphics-reference-library.md#official-threejs-implementation-references)
and [Bruno world reference](/Users/lucid/Documents/hyperia/hyperia-implementation/docs/graphics-reference-library.md#additional-independently-located-references)
remain the design inputs. No external code or assets are imported by this work.

## Current priority — WORLD FIRST, 2026-09-15

The user's direction is **world first; avatar and armor later**. This current
queue supersedes the older shape-after-material and next-metal plans below;
all historical evidence remains intact. The armor audit is paused with only
an isolated unrun script and no measured JSON, asset or armor-material changes.

The new shape trial uses existing admitted controls: lowland `westHoldX=394`;
terrace crest/shelf heights `17.5/7`, scarp/shelf/apron widths `16/8/30`;
north saddle depth `0` at `-20`, southern saddle center/half-width/depth
`27/24/0.5`. The 24 m meadow feather and 25.3 m southern height stay fixed.
This broadens the inlet-head descent and gives the ridge one dominant shoulder
instead of three similar cones; no new noise, schema or default selection.

Scoped source checks pass **29/29 shape**, **60/60 terrain material** and
**16/16 UI**. Actual fixed travel checks retain the 5 cm/10°/0.4 limits and all
35 grove slope checks pass; these are not native movement or visual approval.
[Candidate13](../../asset-studio/fine-meadow01/southern-meadow-candidate13.json)
passes **1,158/1,158 across 70 files**, types zero diagnostics, shared/server
builds exit0 and 175 unchanged source pins.
[World04](../../asset-studio/fine-meadow01/southern-meadow-world04/receipt.json)
passes derivation and separate fresh verification: 186 source pins, 41 manifests
(39 unchanged), all 35 groves with 29 re-grounded Ys, 14 roads and 21 supports;
maximum grove slope 0.3424295592. Fifteen exact resource links and delivery
documentation are verified. [Replay11](../../asset-studio/fine-meadow01/equipped-lighting-replay11.json)
passes **200/200 in 27.3 s**, source pins unchanged. Replay10 remains failed
**198/200**; two stale-selector tests now require the explicit v2 selector.
[Native07](../../asset-studio/game-test-integration/southern-meadow-native07/report.json)
is terminal **EXIT1** on actual WebGPU at 1280×720/DPR1. All five coastal PNG/HUD
captures pass; `coastalCaptureCompleted=true`. The cow404 failed-asset/unexpected
console error causes the nonzero exit; fourteen known dagger-fit errors remain
a separate blocker, not that exit cause. Cow-placeholder/armor work stays deferred.
Page/GPU and cleanup errors are empty; browser/stack cleanup, four empty ports
and unchanged sources are verified.
[Independent verification](../../asset-studio/game-test-integration/southern-meadow-native07/verification.md)
confirms all **811 archives / 302,738,630 bytes** match their hashes, plus the
five PNGs, RGB owners, exact HUD restoration and fog checks.
Scheduling was performed, not qualified: cameras change in both windows and
population changes after study, so no controlled benchmark or performance pass.
Terrain-preparation completion remains false with the overall nonzero exit.

[Five-pair visual review](../../asset-studio/game-test-integration/southern-meadow-native07/visual-review.md)
supports retaining the shape/tint as an **opt-in partial improvement**: broad
meadow color patches, a gentler cove descent and less repetitive skyline.
The excavated bowl, long flat ridge crest, serrated pond, plain paths and sparse
composition remain. Keep defaults and failed receipts; no full-run, navigation,
AAA or performance acceptance is claimed.

Reference mapping: [Ameen's grassland](https://above-the-grassland.pages.dev/)
informs larger coherent ground/vegetation color patches;
[Jaime's Gaea source](https://github.com/JaimeTorrealba/creative-lab/blob/d2003439fae35078ebcefdd40176d39e7b293fcd/src/components/demos/d-g/Gaea.vue)
informs deliberate unequal relief, not a copied terrain implementation;
[official Three.js terrain](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_tsl_procedural_terrain.html)
informs readable height/slope material structure. The current material candidate
retains **20 surface texture fetches unchanged** and adds **one additional fetch
from the existing noise texture**: three noise fetches versus the old Haven
graph's two. This source count is not a GPU benchmark. No external
implementation/assets or new render pass is implied.

Prioritize natural paths, water/shore shape, terrain texture relationships and
varied vegetation as one coherent island, with actual open-ground navigation,
functional support/resource preservation, HUD reliability and measured costs.
The reference library below remains the design input; no full-world/AAA,
performance or default-promotion gate is closed by these source checks.

Current bounded path application: selected pond-bank and bank-lobby cores are
narrower, with four asymmetric partial-wear pieces and unchanged original route
points, endpoints, ground and service supports. No textures, passes or meshes
were added. [Focused03](../../asset-studio/fine-meadow01/natural-path-wear-focused03.log)
passes **16/16**, including connected cores, exact 256-mask positive footprint,
bilinear keepouts and scalar/filtered asymmetry. Failed startup-fixture01 and
512-mask02 receipts remain. Storage stays **262,144 bytes**, but segments rise
**301→505**: CPU/worker and grass costs are not proven unchanged.
[Candidate15](../../asset-studio/fine-meadow01/southern-meadow-candidate15.json)
passes **1,162/1,162 across 70 files**, zero shared type diagnostics, shared/server
builds exit0 and 175 unchanged source pins. Candidate14 remains failed despite
all tests passing: four old `Object.hasOwn` typing errors were corrected with
equivalent test-only own-property calls.
[World05](../../asset-studio/fine-meadow01/southern-meadow-world05/receipt.json)
passes derivation and separate fresh startup: 186 independently checked current
pins; all 41 manifests exactly match world04; 35 groves, 18 surface paths and
21 supports, maximum grove slope **0.342429559198712**. Fifteen resource links and
[asset delivery](../../asset-studio/fine-meadow01/southern-meadow-world05/ASSET_DELIVERY.md)
are verified.
[Replay12](../../asset-studio/fine-meadow01/equipped-lighting-replay12.json)
passes **223/223 across eight harness files in 28.572 s**, exit0, no
skips/failures/timeouts; eleven source pins unchanged and independently rechecked.
[Native08 verification](../../asset-studio/game-test-integration/southern-meadow-native08/verification.md):
power connected; v3/world05 terminal **EXIT1**, all **seven** world PNG/HUD
captures complete on actual WebGPU at 1280×720/DPR1. All 14 RGB boundaries and
seven fog rows pass. Roof waits **45.245/1.354 ms** are within 1,000 ms;
HUD totals **≤4.1 ms** retain the exact 450 ms limit.
Study/report match; **908 current pins and 812 archives / 332,963,653 bytes**
are independently hash-checked. Cow404 causes five unexpected errors and EXIT1;
14 dagger-fit errors remain a separate known blocker. Page/GPU/cleanup errors
are empty; browser closed, launcher exited 0/absent, four ports independently
clear. Both RAF windows completed but are unqualified: cameras moved and
population changed after study. No performance acceptance.
[Visual review](../../asset-studio/game-test-integration/southern-meadow-native08/visual-review.md):
partial progress, **not art-approved**. Rounded/disconnected path ends, blurry
shoulders, sparse lawn and regular shores persist; no default promotion.
The **301→505 segment** cost remains unresolved.

Bounded next scopes:

- **Path joins and wear:** connect paint continuously to actual destination
  aprons/platforms and replace obvious rounded caps/blurred shoulders with
  meaningful traffic wear. Do not preserve visible green gaps merely to keep an
  old footprint golden. Protect real navigation, collision and support; verify
  near/grazing/overview views, motion, grass population and costs.
- **Pond, separate height/shore scope:** the [CPU experiment](../../asset-studio/fine-meadow01/pond-bank-feasibility.json)
  ([script](../../asset-studio/fine-meadow01/pond-bank-feasibility.mjs)) reduces
  reconstructed upper-contour maximum error **0.55610→0.09498 m** over 256
  directions on resolution-128 leaves. Two leaves add **7,422 vertices,
  14,712 triangles and 592,176 bytes**; same-level edge error is approximately
  floating-point epsilon. The real assembler/retained sampler uses synthetic
  surroundings, zero roads and a diagnostic square proxy, **not a production
  solution or runtime pond admission**. Coarse-resolution-32 face-cap/bracketing
  failures remain. Proper annular refinement and LOD policy are unresolved;
  preserve water level, bed, ecology, routes and station support, with separate
  topology/contact/cost and native proof. Road-mask resolution is not a pond fix.

## Expanded reference library — 2026-09-15

The [graphics reference library](./graphics-reference-library.md) records the
user's six portfolio/world references, all 18 listed Ameen projects, Jaime's
151-demo route inventory and the official 607-example Three.js catalogue
(230 WebGPU). Selected live views and source inspections are distinguished from
catalogue-only review. It maps terrain, vegetation, water, lighting, weather,
animation and spectator work to concrete examples, reuse limits and acceptance
checks. Research is complete for this pass; adoption and actual in-game visual
qualification remain open. No external implementation or assets were imported.

## Reference-led integration decisions — 2026-09-15

Public source review is an input to the next in-game comparison, not proof that
an effect is faster or that this world meets the visual target. Preserve our
existing instancing, LOD, rooted wind, thin-leaf lighting, layered PBR terrain,
antirepetition, wave/foam and sky-environment systems while evaluating these:

- [Bruno Simon's WebGPU/TSL grass](https://github.com/brunosimon/folio-2025/blob/main/sources/Game/World/Grass.js):
  reference the coordination of terrain tint, patch-scale blade height and wind.
  Our acceptance target is soft connected meadow coverage with varied woodland
  edges, not uniform lawn or a new grass implementation solely for feature count.
- [Three.js procedural terrain](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_tsl_procedural_terrain.html):
  reference readable slope/height/material relationships; retain our stronger
  existing layered material and authoritative gameplay ground. The example is
  not a finished island design or a reason to increase terrain resolution.
- [Three.js depth-aware water](https://github.com/mrdoob/three.js/blob/dev/examples/webgpu_backdrop_water.html):
  compare foreground-safe refraction and depth readability against our actual
  near shore and pond. Refraction is not yet an established cause of the pond's
  artificial appearance; do not adopt another render pass without a measured
  visual benefit and same-scene GPU/memory cost.

The folio repository declares an [MIT software license](https://github.com/brunosimon/folio-2025/blob/main/license.md).
Before copying code, pin the exact revision and retain notices; separately check
each third-party asset's license. No external code or assets were imported in
this review. These links are technique references, not newly approved art.

Live browser review also inspected the reference's entry and surrounding night
scene: irregular grass boundaries, small ground details and coordinated warm
lamps against cool ambient light are useful composition references. This was not
a performance benchmark or permission to replace our fine-blade meadow style.
The temporary reference tab was closed after inspection.

For each proposed adoption, retain a matched in-game before/after at the same
camera, resolution, quality settings, scene population and lighting phase; also
review motion and the actual equipped avatar. Record visual benefit, CPU/GPU
cost and regressions together. Source tests alone cannot close these gates.

### Next shape work after the material comparison

The native03 overview's excavated inlet head is the authored half-ellipse in
`CompactIslandLandform.ts`, not a missing texture. The active lowland bypasses
the older apron knots and preserves the legacy bay west of its curved boundary;
inner-head points around (400,468)–(411,480) remain outside its influence. The
three similar western peaks come from two similar saddle cuts through a constant
20 m terrace crest. More face noise or changing bypassed apron knots cannot fix
these silhouettes.

Next, compare an identity-bound, omitted-by-default longitudinal valley/bank
section with unequal bank widths and a gradual head descent. Preserve sea level,
open mouth, seabed and outer envelope. Separately vary the bounded western crest
with one dominant shoulder, a lower secondary shoulder and a broad saddle.
Keep original/default and large-world arithmetic intact. These are proposed
shape changes, not implemented or accepted geometry.

Retain the 21 canonical support owners, pond and 14 roads. Re-ground every one
of the 35 groves without changing IDs/XZ/species/scale/yaw or the 0.35 slope
limit. Recheck existing travel, retained-contact/normal, worker-parity and
geometry-budget gates, then judge matched actual in-game views and movement.

Current source status: the coastal-ground and matching grass-placement changes
pass [candidate10](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/southern-meadow-candidate10.json):
1,054/1,054 tests across 63 files, shared typing, shared/server builds and 163
unchanged source pins. The material change does not change shape or add texture
samples. [World03](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/southern-meadow-world03/receipt.json)
now passes derivation and independent fresh actual-world verification: all
174 source pins and 41 manifests verified; all 41 are byte-identical to world02.
All 35 groves pass (maximum slope 0.3424295592), retaining the same 29 changed Ys,
six unchanged Ys and 21 supports. Receipt: 100,494 bytes, SHA256
`ac6c0a30fe91dfded53d24fe4c66d392a88f9e6dc9aae90a183a835434c418d7`.
Fifteen exact shared-resource directory links preserve the originals; actual
launch-asset validation passes without changing world01/world02 or old receipts.

The optional equipped day/night harness is implemented for two actual actors
and 14 equipped parts, preserving the five coastal views, both RAF windows and
natural 240 s clock. [Focused04](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/equipped-lighting-focused04.log)
passes 46 checks (43 + 3), both commands exit0;
the historical coastal-fog normalization assertion is corrected, not removed.
Full archival replay is still unverified: combined session85224 first reported
that normalization failure, then children57810/57811 stalled with fd12r open on
current `packages/server/world/assets/manifests/items/weapons.json`
(47,218 bytes, `compressed,dataless`). The exact tree was stopped at eight minutes;
session exit1. The separate full01 stalled on current
`packages/shared/src/extras/three/three.ts` (16,826 bytes, `compressed,dataless`)
and was stopped after three minutes. Both paths are in `hyperia-implementation`.
These are iCloud-offloaded read stalls, not deleted files. About 23 GiB local
space remained at 98% usage, distinct from cloud capacity. No recovery, move,
deletion or global-setting change was made.

No native04/GPU run launched; current pixels, performance and gameplay remain
unverified. Historical native03 below does not qualify the new source or prove
a visual gain. Full-kit, world-art and production acceptance remain open.

Historical source checkpoint (2026-09-15): detached-world integration is in progress,
not accepted art. Explicit `ASSETS_DIR` now selects the same server filesystem and
HTTP manifest root; 28 actual filesystem/Bun/Fastify tests plus format/lint/scoped
types pass. The first detached41-file bundle correctly fails resource startup for
one tree's 0.358071 slope (limit0.35), despite all35 canonical Y values matching.
Widening the blend admits trees but violates the fixed meadow's stricter6% grade
target; candidate06 is retained failed1045/1047 and its types/builds did not run.
The selected recipe keeps the original 24 m blend with a 30 cm higher southern meadow
target (25.3 m). Focused02 passes 26/26 with independently reviewed literal geometry
proofs: all 35,496 retained/canonical samples remain within unchanged 5 cm/10°/0.4
limits (maximum gap 2.045 cm, angle 7.743°), all 6,756 protected and 7,497 outside
samples remain exact, and all three staged/synchronous geometry buffers match.
Full candidate07 passes 1,047/1,047 across 63 files, test-inclusive shared typing and
normal shared/server builds; all four commands exit0 and 163 source pins remain exact.
The 41-manifest world02 bundle now passes fresh DataManager/Terrain startup and
actual production admission of all 35 groves: 29 Y changes, six unchanged Ys, 14 roads,
25 tiles, nine content owners and 21 canonical supports. Maximum grove slope is
0.3424295592 under the unchanged 0.35 limit; no tree was dropped or gate weakened.
Only world-config/world-areas differ; the other 39 files remain byte-exact. Content
identity is `5a7474ff7364c21df7f31680c176d7c152ffda4c33af0946f1d0e70a098bc5cf`;
the [world02 receipt](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/southern-meadow-world02/receipt.json)
is 100,494 bytes, SHA256 `f97b7781e673bb927981219784fc3eb22a440dc6386bb111d5689c3ac3bdba7d`.
All 174 executed-source pins, live manifests and failed world01 evidence rehash exactly.
Current world02 runner/observer checks pass 137/137 and 31/31; later runner and
delivery closure checks pass 169/169 and 7/7. Native01's prelaunch grass-PNG
allowlist failure and native02's launch asset-root failure remain retained. Fifteen
exact shared-resource directory links plus ASSET_DELIVERY.md now provide the
detached root's resource layout without copying assets or changing its 41
manifests; the actual launch validator passes four areas/28 resources/18 NPC
definitions/six station types.

Current candidate native checkpoint (2026-09-15): southern-meadow-native03 delivers
all 41 manifests with HTTP200/exact bytes and observes world02's identity in first
and last browser readiness. The unchanged readiness gate completes in 19.833 s
with 71 observations. All five actual 1280×720/DPR1 WebGPU images are saved: four
historical cove/pond view matches plus one separately daylit lowland overview.
The [report](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/southern-meadow-native03/report.json)
is 55,791,440 bytes, SHA256
`d5e5ace6e0b1a0a002f209b1a508ef8cfd0e5f55a77b9f7d27512ce71d2991ae`.
Independent verification confirms all 902 current pins, 806 executed archives,
five image hashes and 4,850 RAF rows with exact recomputed summaries.
Post-equip records 621 callbacks/10.0000 s with p95/p99/max 25.8/40.8/50.0 ms;
post-study records 889/10.0083 s with 24.9/25.9/108.4 ms. Cameras move, population
changes in the second window, and the host is on battery: not a controlled
speedup, presented FPS, GPU-cost or performance acceptance.

Overall native03 remains **EXIT1** for the cow HTTP404/five unexpected console
errors; 14 known dagger-fit metadata errors also remain production blockers.
There is no thrown report/study error or page/GPU/cleanup error. Owned browser,
launcher/services retire, all four ports clear, and the isolated database remains
stopped. Visual review sees the short southern cliff replaced by a connected
descent, but the uniform lawn, repeated rock, cone peaks, dark trees and pond are
still unaccepted. No walking/contact, motion or GPU-cost study was performed;
player/agent contact, scene-wide visual and performance/endurance gates remain
open. Live manifests/defaults are unchanged; no default promotion or goal
completion. [Current evidence](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/QUALIFICATION.md).

### Historical staged-preparation02 checkpoint (retained text)

Latest native checkpoint (2026-09-15): staged-preparation02 reaches original island
readiness in 18.398s and completes five actual WebGPU views plus both 10-second
RAF windows at unchanged 1280×720/DPR1. Post-equip/post-study RAF p95 is
17.4/17.2ms, p99 25.1/25.2ms and maximum 41.8/41.4ms. Cameras move and grass
population changes after the study; the Mac is on battery. These are diagnostics,
not a controlled speedup, smooth-60-FPS, GPU-cost or production acceptance.
The artificial plateau/rock wall, lawn and pond rim remain visually unaccepted.
The run still exits1 for the missing cow asset; dagger-fit errors also remain.
No new page/GPU/cleanup error occurs. All 826 pins and 730 archives rehashed at
that verification (the current harness/fixtures have since changed); owned
processes retire and databases remain stopped. The unactivated meadow candidate includes
smooth backing overlap, a wider coastal join and local floor/collar refinement.
The earlier24m-feather candidate05's 35,496-point contact test passes at 2.03 cm maximum gap and 7.74° maximum
normal difference; these are not contact results for a newly adjusted recipe.
Candidate05 qualification passed 1,047 tests across 63 files,
eleven-changed-test-inclusive typing and normal shared/server builds with 163 pins held.
The generator, fallback and strict retained admission now share private resumable
preparation, complete input leases and guarded scene publication. All measured
buffer hashes and original contact samples remain exact. The 2 ms scheduling target
is not a hard ceiling: the mixed CPU case reports 2.652 ms maximum slice / 1.568 ms
maximum step. Native02 observes a 2.7ms maximum preparation slice and 1.9ms step,
not a hard 2ms ceiling. Its slice counter also includes idle passes. Native loading,
frame-tail, memory and full gameplay budgets remain unaccepted. Manifests and grove
heights remain unchanged; the new views show the current profile, not the candidate.
Diagnostic source qualification passes 143/143. Staged01's after-study cumulative
grass-counter mismatch remains failed; staged02 uses the existing 1-second fresh
publication/owner check only for explicit post-study diagnostic snapshots, with all
other fields still exact. It does not reclassify old evidence or loosen loading.
[Evidence and next action](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/QUALIFICATION.md).

### Immediate landscape acceptance work

1. Preserve the qualified world02 content and now-verified server/HTTP/browser
   identities while resolving the retained cow and dagger content blockers.
   Never inject a different profile into an already identified world or promote an
   unqualified default. Current-profile diagnostics are collected, not accepted art.
2. Verify native loading/frame/memory budgets, then prove actual player/agent foot
   contact and camera behavior. Scalar support, cached ground, rendered faces and
   physics are distinct; source contact tests do not qualify all four.
3. Preserve world02's verified 29 grove Y changes, all 35 resource anchors and pinned
   identity while improving the still-unaccepted landscape and traversing the full
   open meadow. The five saved views do not establish visual or gameplay acceptance.

## Current direction — natural, dry, full and freely explorable

### Short normal-player movement passes — scene-wide art and travel remain open

The new rigid local-matrix candidate is source verified at five owned grass/terrain/
water sites: 40/40 focused checks, test-inclusive types/lint/format, then 961/961 shared
checks across 60 files and normal shared/server builds, with 160 pins held. It preserves
world auto-update and is not the unsafe blanket scene-matrix reuse proposal. No native
or measured performance gain is established. [Qualification receipt](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/rigid-local-matrix-qualification01.json)
SHA 28058f0f7f004955186a74896db9b5868bb18896abeb2d6e746ebb2c900a2773.

Late-visual01 fails launch asset validation before any browser/game server/database
or images, with 808 pins held—not terrain/material rejection. Existing bow-run 81,240 B
and then 2h-walk 53,120 B files are restored/resident byte-exact after timed-out reads.
Full validation now passes 4 areas/28 resources/18 NPC definitions/6 station types;
late-visual02 subsequently exits 1 at the 60-second DOMContentLoaded navigation
deadline, with 808 pins held and no renderer device/images. Six cleanup errors remain;
server 0 plus ACK and absent owned processes/stopped database do not erase the forced
client SIGKILL or wrapper exit 1. Current procgen originals are offloaded again, but
the cause remains unproven—not a rendered-art or frame-rate failure. [Late02 report](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/compact-cove-late-visual02/report.json)
SHA 3451a43deb1d11e668add0306056d3121ed54c3bdd33c0bef959776d9cf63268.
The helper's 10+2 checks and diagnostic-only 180-second allowance preserve the
original 30-second readiness failure; new imagery and all broader gates remain open.
The failed report's launcher/absent-delivery cleanup assertions remain intact.
[Retained report](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/compact-cove-late-visual01/report.json)
SHA ea0e681f713e59c30370041552c875ebd6c75bcec03366f849481066309264f8.
Keep terrain authoring behind the current visual review; no source-test count closes
the nine quality gates. The Three fix remains STAGED only at HEAD ea43f588.

[Movement06](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/normal-player-movement06-verification01.md)
passes 1/1 with one real canvas click: 3.5355339059 m, six samples, two intermediate
positions and zero arrival error. Its strict readiness wait succeeds, including
terrainTimedOut=false (predicate proof, not a separate flags snapshot); terrain
initializes 121 tiles and actual before/after receipts show non-fallback Apple
Metal-3. All eight pins hold. Five cow errors remain; duplicate-Three/no-mesh warnings
are zero. Cleanup independently records ACK/server0/client143/Chrome0 without forced
stop and with owned processes/ports clear. This is a short normal-player input/physics
slice, not whole-island, off-road/service/shore coverage, AAA imagery or performance.
All nine scene-wide quality gates remain open. Verification JSON SHA
2048973e693045c28549c00d1a33dbbc3543b34ce5aec9dc41e6d72a2170497c.

Movement04's real Three/Vite identity correction restores visible tree meshes and
removes movement03's 1/58 duplicate-Three/no-mesh warnings, but terrain readiness
still fails and its client requires SIGKILL. Its actual four read-blocked Vite/libuv
workers and 35 procgen original-source descriptors are concrete current I/O evidence.
Finder hydration recovers 13 dataless originals and the [118-source residency closure](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/normal-player-movement04-source-map-residency01.json)
is hash-checked; Impostor embeds sourcesContent and needs no extra hydration. This
does not prove the cause of movement03's historical stall. Movement05 then delivers
all nine sky images in 13.280–25.831 ms and all 118 procgen modules, but a [verified
439-second host sleep](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/normal-player-movement05-power-events.txt)
interrupts the run. Its post-wake renderer timeout/loading image is not assigned a
new rendering regression. Movement06 passes on the same sources with a bounded
caffeinate guard, not changed saved power settings. Previous failures remain intact.

[Loading diagnostic01 analysis](/Users/lucid/Documents/hyperia/asset-studio/fine-meadow01/loading-diagnostic01-analysis.md)
is complete, but stream readiness still fails: 817 pins/721 archives hold, zero art
captures and one loading-overlay image. Rendering traversal/submission dominates
the CPU samples; grass progresses with frame cadence and stable ownership, not a
stalled iterator. GPU median25.952/p95 36.176 ms and CPU-tick median19.1 ms cover
instrumented changing populations, not settled FPS or material-specific attribution.
Blanket matrix reuse is held UNSAFE because a real bow render hook depends on later
descendant-transform propagation; no such optimization is implemented. Nineteen
known content errors remain in that diagnostic. Review art05 and expand actual
travel/rendering evidence before accepting terrain, movement or performance quality.

The Three/Vite config and actual class-identity regression are STAGED only. The
checkpoint attempt ends without a commit after cloud-residency reads; HEAD remains
the pushed buffer checkpoint ea43f5881c52. No hook-backup stash change or owned Git
process/index lock remains. iCloud residency is a host/workspace condition, not a
game requirement; relocation is not authorized. Other navigation/world work is not
claimed committed. Qualification12 remains source-only for its captured bytes.

### Normal player spawns, then world readiness fails — movement remains unverified

Movement03 passes actual player spawn without the prior worker/require errors,
then the later navigation.spec.ts:171 readiness wait times out after 120 seconds
(CLI 1). Root's retained image shows normal HUD over a black world with tiny horizon
props, not an acceptable terrain or walking result. Trace/source diagnosis remains
open; do not infer a terrain-art regression or an observer-only cause from this.
CoreUI's 20-second timeout sets terrainTimedOut and terrainReady true and stops
polling, so the HUD is not actual terrain readiness. Sequential Environment.start
waits for SkySystem.init before Terrain.start: five sky images and a procgen import
take about 93 seconds, while four sky requests receive no headers. Current files
are resident. A later same-config HTTP probe first establishes the real import
allowlist, then serves all nine sky images/procgen with200 and matching hashes in
258–604 ms. It does not explain the earlier93-second stall or prove a file-I/O cause.
Probe01's direct-procgen403 is preserved as setup failure. The class-identity
correction was unverified at that stage; the later native evidence above records
its effect without bypassing mesh guards.
This normal-world startup issue is separate from the stream's unfinished grass work.
Server acknowledgement/exit/close 0 and Chrome 0 are retained, but the client needs
Playwright SIGKILL after five seconds of SIGTERM. All owned processes/ports are
clear and the database stopped, yet cleanup is not fully graceful. Console SHA
6e7b20a6efd519e168e9fb234c925894e17a7b7c2977d83b19060ff8b62eb986.

### Client bootstrap/import fixes source checked; earlier failures preserved

The real-file native test bootstrap is source checked: three focused real-worker/
preflight tests, client noEmit, lint/syntax and native 1/default 3 test discovery pass
under the central exact Node22.23.2 policy. No production agent behavior is disabled.
Actual movement02 avoids the prior worker restart error, then fails naturally
with CLI 1 at the unchanged 120-second player wait: the browser reports require is
not defined from a deep buffer import outside Vite's bare-buffer optimized entry.
The one-line bare-buffer correction passes its actual Vite-resolver test 1/1 plus
client noEmit, lint/syntax/format, with fallback behavior unchanged. Movement03
subsequently passes player spawn but fails world readiness. No walking or accepted world image is established.
Owned teardown is clean and the stopped database/failed trace/image are retained.
Console SHA 1632c9a87cc433a9e15a3c41f5ec879b09d6c623a3a9be279911da822cb0a1b1.

The separate grass-loading diagnostic is explicit opt-in, passes 15 focused and
corrected 2/2 closure checks, and now captures actual loading-only evidence. It
still fails readiness, with no loading fix or art acceptance yet. Keep the next
terrain work behind actual loading diagnosis and the held art05 review.

### Art04 stops before imagery — loading diagnosis before another terrain review

Art04 fails its 30.002-second grass-readiness wait after 104 observations while
running jobs decrease 112→67 and completions grow 11→56. The last published/current
active-slice counters differ 3004.5/3008.2 ms, but 67 jobs remain unfinished; neither
an observer-only explanation nor a deadline relaxation is established. Cold-load
frame cadence needs investigation, not an assumed GPU diagnosis. No image is
captured. All 814 source pins/718 archives remain unchanged; 19 known content errors
and zero page/GPU errors remain. Actual terminal acknowledgement, server 0/client 143/
launcher 0 closure and no forced/residual groups establish a clean shutdown only,
not an art pass. Report SHA 060e764693efab9858705cb1676587eaf87af024f7d44766b47c6d980d66cf75.

Investigate loading first, qualify any correction, then review art05 before changing
the terrace recipe. Separate normal-player movement01 fails during test-stack
startup: inherited --input-type=module causes a real worker restart loop, not
verified walking. Root interrupts the attempt; its trace and blank dark failure
image remain evidence. The corrected real-file bootstrap passes focused source
checks; movement02 then fails the distinct browser dependency route described above,
without disabling agents or changing AgentBehaviorBridge behavior.
Owned shutdown is clean but does not establish movement. Console evidence SHA
321fbc91ce8e8acdf6b32ef631d42d00eec6d24e8fe8a16dc7d9042781845d6f.
Cow-model delivery and normal dagger certification remain separate
launch gates: the cow candidate is still blend/FBX rather than runtime-ready, and
neither the legacy nor authored dagger has current-avatar duelFit approval.
The scoped lifecycle/launcher commits 9bc6e850ca96 and 27fa7be9bceb
are pushed normally to codex/sol-duel-stream-launch under dreaminglucid; this does
not claim all outstanding world work is committed.

### Source qualification12 passes — art03/art04 failures preserved

Fresh qualification12 passes 958/958 shared checks across 60 files, shutdown26/26,
launcher23/23, packing9/9, three package types, same-config fourteen-test typing
and normal shared/server builds. All twelve commands exit0 without a signal and
all156 source pins independently hold. Both movement configurations are discovered
only. Receipt SHA e02847d28d404ae8b4c0cb0bf91ac88633af550f350d98c66d41fc6f5c81b2e7.
There is no landscape change since qualification11; this covers the deployed
launcher repair. The held five-view headed Metal/WebGPU art04 subsequently fails
readiness with unchanged gates and no images. Actual walking remains separate.

The Mac is now unlocked. Native art03 reaches the real launcher output handler,
which throws for undefined STRUCTURED_SHUTDOWN_EVENT_PATTERN at
scripts/duel-stack.mjs:786. The later 60-second agent-VRM admission times out;
no image is captured and this is not a rejection of terrain or asset appearance.
All 803 source pins/718 archives remain unchanged. Launcher exit 1, missing retained
terminal completion/close and the original report errors are preserved, despite
verified browser closure, absent owned processes, clear ports and stopped database.
Report SHA ee88b28cad7bc70f1b40eabb5ca52be098a7412f8f371537ac89b5beda897df4.

The remaining reference is corrected, with 23/23 actual-handler real-child tests
and syntax/lint/format passing. Qualification11 did not cover this deployed branch;
full qualification12 now passes and native art04 subsequently fails grass readiness.
The same five intended
views and separate real walking remain unaccepted. The Git hook's unrelated
cloud-only file is hydrated and matches HEAD, with its mode preserved; the scoped
normal-hook checkpoints are now pushed as recorded above. There is no
new terrain, movement, performance or runtime PhysX approval.

### Current lowland and rock candidate — source checked, awaiting native review

The new source candidate replaces the stacked apron with a broad asymmetric
lowland:57m authored descent,24m full-width center and a64m lateral bend. It is
not a required navigation path. Exact active manifest SHA
c64622114d5f91052256e6d706c5586f8f1b5a26fa3720a623b0929c45f0c1b6.
All82 focused tests pass, including actual emitted workers and historical recipes;
test-inclusive shared types and scoped lint/format pass. The sampled terrain-only
integer-cell region is1061m² and connected without diagonal corner cutting.
Across11866 route/area probes the retained-mesh gap is at most0.0392628212m,
face grade0.3083914602 and normal difference4.288987degrees, with no wet corners.
The expanded22442-point bank grid is now within0.3m (0.2984605668m); this certifies
only that retained grid/detail level, not every camera or terrain transition.
The previous shoulder's0.316533m result remains its failed target, not rewritten.
Service grades and checked functional/grove anchors are held. Actual populated
player/agent movement, appearance and performance are still open.

Rock now uses the existing continuous paired projections on all three planes.
Source checks pass53/53 with test-inclusive types/lint/format; root and independent
review find no concrete source blocker. Six maps remain but the surface read
budget increases14→20. Mean-centered albedo compensation is approximate, not exact
histogram preservation; it requires moving/oblique/mip and GPU-cost review.
No blanket roughness, exposure, foliage density or resolution change is part of
this candidate. Current code is covered by qualification12, not by the earlier
qualification07 build.

Previous qualification11 passes958/958 shared checks across60 files, shutdown26/26,
launcher22/22, packing9/9, all three package types, same-config fourteen-test
typing and normal shared/server builds; all156 source pins independently hold.
Its only new landscape prerequisite is strict optional arenaFloorDatum with
legacy compatibility and pre-registration admission. Focused03 passes12/12,
including actual test-world floor/collar/solid/mesh/return contracts and340 nearby
unchanged Float64 samples. Focused01's failed stale18-zone expectation is retained;
the named-lodge assertion recognizes the actual nineteenth zone, not a removed
grade. Both live terrain/world-area manifests remain byte-identical. Receipt SHA
565a8bfbd13c1b531f95617c431abc09338aada738bc4a7c02ef0ae77b3d006e.
The single added native loader archive passes its closure test at803 pins/718
archives plus eleven unchanged dynamic pins; no capture settings or visual guards
change. This is source verification only, not native appearance/performance or
runtime PhysX approval. At that checkpoint art03 and movement were unrun, the Mac
was locked and Git was separately blocked. The resumed attempt and resolved host
blockers above supersede that status, not the qualification11 receipt.

Previous qualification10 passes 940/940 shared checks across 58 files, shutdown26/26,
launcher22/22, packing9/9, all three package types, same-config twelve-test typing
and normal shared/server builds; all147 source pins independently hold. Movement
is discovered, not executed. The forwarding correction passes81 focused checks
(15 new historical trace/byte/cancellation cases), with numerical code and budgets
unchanged. One diagnostic profile pair shows lower pipeline samples, not a causal
39% improvement, stable-speedup or production promise. Receipt SHA
a7047b1e2acd0f64258c5b55789c99f357f80645a0018cd423fdc7a507f34da1.
At qualification10 the locked Mac and Git residency blocked the next steps;
that historical state is superseded above. Source verification does not close
appearance, walking or frame-cost gates.

Full qualification08 remains FAILED at 924/925 across 58 files: its old assumption
that one of twelve radial first-shore crossings intersects the gentle coast misses
the new lowland. Actual TerrainSystem sampling at X 442.9134491083,
Z 489.0253528999 finds height 19.0375 m, slope measure 0.0282509775 and soil weight
0.6105149465. A named thirteenth, manifest-driven centerline transect now preserves
all twelve original rays and every material/ramp assertion and threshold. Focused
material checks pass 53/53; lint/format pass. Test SHA
f90c581a5602aa9ca960f3ae7e7441b1cb5aec302a9c71b9211c014588cbf120.
This is scalar source evidence, not native appearance approval.

Historical qualification09 remains FAILED, 922/925: two actual grounding jobs hit the
unchanged 250 ms active-CPU budget with current inputs and no publication; a
separate station-boundary lifecycle upload assertion fails with cause still under
review. Preserve both failed runs and investigate without budget/population changes
or repeated runs selected for a pass. Qualification10 now passes after the
forwarding correction; the historical station-job cause remains unproven.
Five-view native art03 subsequently fails before imagery; the candidate remains
visually unaccepted; art04 also produces no images, so loading investigation
precedes the next art05 review.

Next native review retains the four existing coastal comparison views and adds
one independently cleared overview of the complete descent. Proposed eye
[495,53,503], target[449,24.21541226635,467] uses actual target ground+.35m;
it has no historical matching image. Review it as a new overview, not a matched
before/after control. Actual normal-character canvas walking follows separately.

### Functional terraces within a rolling island — datum prerequisite source verified

Capture the current lowland/rock comparison before changing the live terrain recipe;
source qualification11 covers the candidate and datum prerequisite, but resumed
art03 fails before imagery. The launcher repair passes qualification12; art04 fails
grass readiness before imagery, so loading diagnosis precedes the next art review.
The separate datum prerequisite is complete in
source without changing the current terrain or manifests. It does not release
either campus grade or qualify future terrace joins. Art02's wide/bay originals
show a broad level lawn above a continuous
rock wall. The source explains a plausible structural contributor, not proven
pixel causality: `CompactIslandLandform.ts` builds mostly positive relief above
28.15 m, then two manifest campus grades impose the same absolute
H = 28.419301523097687 m. Earlier “broad arena grade release” changed grass
exclusion only; `TerrainStationGrading.test.ts` deliberately preserved heights.
The measured coast metric is s = 1 - abs(normal.y), not rise/run: for an upward
unit normal, angle = acos(1 - s). Thus s = 0.235–0.536 means approximately
40–62 degrees, not a 23.5–53.6% walking grade. Material tuning cannot turn those
faces into a gentle shore.

The actual baseline below is derived from the current manifests and shared
factories, not proposed coordinates. X/Z intervals are in world metres;
“support” is the outer grading AABB, not uniformly flat area.

| Owner | Exact core / support | Preserve versus release |
| --- | --- | --- |
| Preparation campus | Core X314–386/Z284–356, 72×72; blend12 gives support X302–398/Z272–368 | Candidate surplus grading; area/gameplay bounds need not change. |
| Duel campus | Core X316–420/Z348.5–433, 104×84.5; blend24 gives support X292–444/Z324.5–457 | Candidate surplus grading, but its H is currently the mandatory floor datum. |
| Authoritative duel terrain-floor core | X340–360/Z394–418, 20×24 | Preserve terrain, combat bounds and spawn coordinates; the actual visual/PhysX slab is separately 19×23, centred [350,406]. |
| Actual lobby / hospital | Lobby X376–394/Z368–384, 18×16; hospital X339–351/Z370–382, 12×12 | Preserve both floors and egress/return support. All three factory floors have a 1 m blend collar. |
| Bank plaza / lodge | Plaza X332–368/Z302–338, 36×36, blend6; lodge's rotated roof/steps envelope X345.5–354.5/Z321.44–332.5 | Keep the existing plaza in this first slice. Lodge Y is exactly H; its 10×12.06 grass-clearance zone X345–355/Z320.94–333 is not the model footprint. |
| Pond | Centre [343,302], bed26.6 m, radial bed5/bank-inner7/bank-outer9 m, bank28.08 m, outer blend2 m; actual support radius11 m | Preserve full radial surface and its underlying blend join; water radius7.5 m/Y27.8 remains independent of ocean sea16. |

The two campus cores cover a union of 13,447 m²; their support AABBs cover
25,180 m². Authoritative duel/lobby/hospital terrain-floor cores total only
912 m²; actual rendered/PhysX slabs total 869 m² because the arena slab is inset
0.5 m on each side. Preserve both existing contracts; do not equate their extents
or infer a runtime physics pass from source mesh construction. Do not
confuse either area with gameplay-zone bounds: `arena-layout.ts` derives a
15 m-margin fallback X324–409/Z353–433, while the loaded `world-areas.json`
explicitly supplies the larger duel bounds above. Keep gameplay admission intact.

Other protected supports come from `stations.json`, `model-bounds.json` and
`stationDataProvider.ts`, not guessed rendered sizes. The provider rounds scaled
model X/Z to 1 m tiles before adding padding. Current station core width×depth /
blend is bank 5×5/2, furnace 7×7/2.5, anvil 5×5/2, range 6×5/2, prayer altar
7×6/2.5, and each of six runecrafting altars 9×8/3. Furnace support is
X329–341/Z330–342; anvil X333.5–342.5/Z331.5–340.5, although their actual scaled
model dimensions are only 2.267646×2.181942 and 1.006355×0.576677 m.
The six rune positions are [368,296], [372,296], [379,298], [379,305],
[373,308], [369,301]; preserve each derived support, not a replacement bounding
campus. `TerrainSystem.loadFlatZonesFromManifest` samples all station grades
after authored overlays and before installing any station pad. Lock their actual
resolved heights before changing the source of those samples. All eleven current
station-center datums equal H, but that does not make every padded footprint
flat: pond precedence intersects part of the prayer altar's support. The pond's
full radius9–11 m collar currently blends into H (height28.24965076154884 m
at radius10), not the raw procedural mountain. The open workshop
adds no ground plane/grade: procgen posts at local X±5/Z−2,+3 and world origin
[336.5,337.5] give four 0.30 m footings centred at X331.5/341.5,
Z335.5/340.5. Preserve their terrain support and owned collision/grass polygons,
not the roof's whole projected area. Each ±0.15 m footing support samples nine
ground points; current bottom/top are H−0.08/H+0.22 m. Preserve the existing
≤0.3 m within-foot variation and ±0.6 m court-datum limits as well as actual
contact; those maximum tolerances are not a target to visibly tilt the structure.

Smallest viable implementation order is one cohesive **service-terrace and
southern-meadow** candidate, not another global height freeze:

1. [x] Separate the explicit duel H datum from the broad rectangle's grading
   effect in `data/arena-grading.ts` and pre-registration admission. Qualification11
   verifies this prerequisite only. The unchanged current manifest still follows
   legacy `getDuelArenaGradeHeight()` admission: its zone must cover the complete
   duel area unless an explicit valid datum is supplied. Keep one authoritative
   datum, not a duplicate inferred terrain sample. Actual test-world construction
   preserves factory terrain Y = H+0.4, visual/PhysX top Y = H+0.42 and return
   contracts; native movement/contact is still open. No broad grade is yet released.
2. In `world-areas.json`/`TerrainSystem.ts`, replace only the two broad grading
   effects with bounded support terraces. Keep every protected surface above,
   including the existing floor collars whose outer endpoint is H. Join farther
   outward to rolling ground; do not expose the old procedural mountain directly
   at the 1 m floor boundary. Exact new joins/widths must come from canonical and
   retained-triangle slope/clearance measurements, not a guessed narrow pad.
3. In the shared `CompactIslandLandform.ts`/`WorldTerrainProfile.ts` recipe and
   `world-config.json`, reshape the positive southern headland into a broad
   connected low meadow around those terraces, joining the captured southeast
   lowland. Its current analytic mound centre [315.35,502.3] and radii
   [72.6,52.8] derive from island centre [350,400], radius165 and
   hill(-0.21,0.62,0.44,0.32); these are baseline dimensions, not new target
   heights. Preserve exact protected heights/joins, shared worker arithmetic,
   coast/water continuation and functional approaches. `CompactIslandPaths.ts`
   supplies surface masks only: neither paths nor these terraces may gate walking.

Keep grove XZ positions in this first terrain slice and revalidate/re-ground
their authored Y. Later grouping may preserve species/count/function, not literal
IDs when moving trees: `CompactResourceGroves.ts` requires half-tile centres and
`tree_${x.toFixed(0)}_${z.toFixed(0)}`, within admitted region bounds and the
40-anchor cap. A relocation therefore needs explicit existing resource/content
reconciliation, not an invented identity exception. `WorldContentIdentity.ts`
hashes these manifests; fresh matching client/server admission is required.
`ClientNetwork` rejects mismatches before snapshot side effects, closes resource
authority and queues, and requires reload (4005); this does not itself migrate
persistent IDs or prove old player targets safe after a content change.

Reuse `arena-grading.test.ts`, `TerrainStationGrading.test.ts`,
`TerrainRadialPondGrading.test.ts`, lodge/court tests, actual emitted-worker and
retained-mesh landform tests, and grove integration tests. Require byte-exact
protected supports, continuous dry off-path connections, unchanged floor/PhysX
and service access, and fresh bathymetry/content invalidation. Then review whole
island views plus actual character walking and motion/cost. Hold map count,
terrain resolution and configured population budgets; changed grass survivors,
visible load and bake work are real effects to measure, not assumed cost-neutral.

### Previous art02 comparison and retained implementation history

Western-shoulder combined-art02 completes all four actual WebGPU views on
2026-09-14 16:26:02.544–16:28:18.552 UTC. Root and capture review provisionally
retain the broader, less sheer shoulder, but the world is NOT visually accepted:
hard grass/rock shelf breaks, the concave cliff wall, repetitive rock, uniform
lawn and dark foliage remain. The pond's circular dark rim still reads artificial;
this is not a new-regression claim. Completed grass-agent independent review
agrees: low/pond views are unchanged, wide/bay improve, and retention remains
provisional, not art approval.
Do not turn the wider shoulder into another minor-tuning acceptance cycle.

Source qualification07 passes912/912 across58files, shutdown26/26, real launcher
20/20, packing9/9, all3package types, same-config ten-test shared typing and normal
shared/server builds. All142 source pins independently hold; external checks
pass179/179 plus focused10/10. Actual field/filter/shader, common-XZ water,
six-texture terrain material, pond and approximately matched daylight checks pass.
All810 native source pins/714 archives/four image hashes independently verify.
No motion, cost, normal-player walking, AAA or production approval follows.

Art02's overall report remains FAILED for all19 cow/dagger content errors;
page/GPU/cleanup errors are0. This run closes the server0/client143/launcher0 in
835ms with no forced or remaining groups. Owned processes/ports are clear and the
isolated database is retained stopped. One clean exit does not resolve art01's
intermittent hang. New server stage/Docker-child records are filtered by the
launcher's existing structured-event policy; that diagnostic retention gap stays
open. Report SHAa1232e7c27889b9ea77bfcefc5338dae7530aae551b0fdc026a060de328a81e8;
independent receipt: asset-studio/fine-meadow01/cove-surface-art02-independent-verification.json
(SHA12bf9c3b6cc20207d2b2c7bff6dc4950b3e5303f6fa708588cb33a1940ce13a5).
The desired0.3m non-route whole-bank mesh target remains OPEN at0.316533m; strict
route safety passes separately. Broader-shoulder retention is provisional only.
Qualification07/art02 cover their captured bytes only; new broad asymmetric
lowland work needs fresh qualification. The source freeze is released. The
current Git checkpoint remains pending, not newly pushed.

### Prior combined-art01 verdict — retained history

Actual combined-art01 is visually rejected. The four WebGPU stills show clearer
rock and less cyan shore tint, but the new straight, long terrace is a shape
regression: it resembles an engineered embankment. Root and independent review
agree. The pond control has no clear new defect. Keep the improved surface/water
provisionally while replacing the narrow straight western apron blend with one
broad curved shoulder. No AAA, walking, motion or performance approval.
The native study's geometry/material checks pass; the overall run fails on the
19 known content errors and server forced shutdown. Original evidence is retained
in compact-cove-surface-art01, report SHA
4310750c7ccb4dcba7335a8005df89252f07f06fa634cfd79f3da3b53bed31e6.

Combined source qualification06 is complete:897/897 across57files, packing9/9,
all3package types, explicit same-config709-root/nine-test types, and normal
shared/server builds pass. All129 pins independently verify. External combined
art checks pass179/179. These results qualify the captured source only; none
declares the cove attractive or the whole island finished.

### Next substantive sculpt pass: accessible southeast cove

The next local visual candidate now adds westernShoulder={maxWidth:24,
startZ:460,endZ:539,featherZ:24}. This curves and widens the former straight
6 m western interpolation while holding its inner edge at X451 and the five
height knots. Source tests preserve all 3,768 actual walking-route heights;
18 of 33,912 route-plus-neighbor probes change, by at most 0.05474445 m, due to
the canonical correction's additional sampling radius. The overbroad earlier
neighbor-equality claim was wrong and its failed receipt is retained.

On the identical retained-mesh bank grid, maximum height gap improves from
0.632388040988 to 0.316532584112 m; near-water improves from 0.398987329101 to
0.160304499592 m. The desired 0.3 m whole-bank target is STILL OPEN; candidate
regression passing does not mean it meets that target. The stricter route limits
(5 cm gap, 40% face grade, 10 degree normal difference and dry triangle corners)
remain unchanged and pass. A northern-onset trial did not resolve the remaining
non-route gap and was rejected. The final manifest SHA is
3f2cc0d7d409ecd2a534c6ee78ee087c01f513de4fe67b552cd9872fa21bb303.
Review a fresh actual wide/low/bay comparison before accepting this shape.

Current implementation supersedes the first whole-inlet trial below. The actual
east-bank recipe uses raw X445–503/Z436–539, feathers6m/20m and1m canonical halo
(X444–504/Z435–540); the upper plateau join moves from q45 to q60. The original
bounded design produced disconnected safe surfaces and was rejected numerically.
The revised support lies east of the actual arena grading support, retaining the
western bank as the rocky side. Real corrected-terrain tests find a continuous
3m approach through (472,435), (472,448), (468,451), (462,453), (456,454),
(454,456), (454,478):3,768 dense samples, maximum eight-direction1m grade0.368876,
minimum height17.490587, zero WATER flags, and nearshore cardinal slope at least
0.071103. Centerline descends27.976575→17.847232. Native walking is still required.
Final five-file focused/historical checks pass58/58, including actual tile/quad/
grass worker admission and agreement, outside/support/anchor preservation and
old-zero joins. Shared-config noEmit includes both new tests with zero diagnostics;
project lint/format pass. Final manifest SHA
8011ef33c08e50ffbbbd9df331120e7cc160063bcf6deb40df87b05b57f655a0.
The additional actual retained-mesh check catches a40.314% face slope in the
18m-feather candidate. That failed receipt remains; widening only featherZ to20m
brings the unchanged route/geometry below the unchanged40% target: maximum face
grade38.490%, height gap4.50cm and normal difference5.27degrees across186 actual
triangles. All containing triangle corners are dry. This is not an avatar walk.
Initial39/40 failed because an isolated fresh-realm test omitted the pre-existing
shoulder freeze; its corrected setup is retained, not a production workaround.

The coordinated material candidate removes XZ-projected dirt from steep coastal
rock using the existing geometric cliff ramp; wetness remains independent.
Current dry dirt already averages roughly0.944 roughness, so a larger global
roughness scalar is not justified by the stills. Pre-cove48/48 material checks
pass; post-cove47/48 exposes a test assumption that every sampled coast is steep.
The revised test requires both actual gentle and steep coasts while preserving
the independent exact ramp/channel checks. Current material03 passes48/48 and
qualification06 passes all897 checks. These checks are not native review. The mapping issue follows the projection distinction
in [NVIDIA's terrain/triplanar reference](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-1-generating-complex-procedural-terrains-using-gpu).
This keeps six maps/fourteen samples. Repeated rock pattern and motion-dependent
normal shimmer require separate observation; do not claim they are fixed.

The opacity-only art trial is deferred, not accepted. The five failed pre-browser
runs remain immutable. Client recovery now passes normal and streaming HTTP plus
graceful shutdown (probe07); use a NEW combined cove/material/conforming-water
art scope after current source qualification. Old history validators stay strict;
changed terrain must be measured as changed, not forced equal to the old coast.

Live conforming water now uses the actual installed dry-inclusive terrain
frontier, bounded staging, complete publication and an eight-ring continuation.
Current focused checks pass31/31 with test-inclusive types/lint/format. Depth3
subdivisions change12→16 to share6.25m lattice coordinates; native cost remains
unmeasured. The current scope is compact single-root streaming, not normal-player
multi-root exploration. Keep that gap explicit until normal route configuration,
local-player focus and actual off-path perimeter walking are qualified.

After the combined images, the next composition priorities are a connected
inland-to-coast swale with asymmetric shoulders, functional woodland groups and
clearings instead of a distant tree band/uniform lawn, and coherent sun/fill/
foliage/sky/water shading. Preserve open gathering approaches and use the existing
resource tree, instancing, culling and material systems; blanket density or
exposure increases are not substitutes for better composition. These are planned
art priorities based on rejected candidate05, not completed improvements.

The current extra functional-tree layout contains35 anchors:14 at the western
ridge foot,12 in the southern meadow and9 on the eastern shoulder. Actual west
anchor extent is22m by73m, consistent with the visibly long band; the authoring
boxes are28m by84m,68m by42m and38m by56m respectively. These are additional
grove anchors, not a complete world-tree count. A later composition candidate
should redistribute this population into irregular groups and usable clearings
before increasing counts. Keep actual choppable-resource identities/lifecycle,
valid canopy/trunk clearance and open approaches, and revalidate authoritative
heights and navigation after any moved anchor. Box bounds are authoring choices,
not justification to restrict player movement or fill the same narrow strips.

The tree/lawn contrast has a specific next measurement: compact trees use scene
PBR and bypass the legacy SSS/ramp path, while fine grass has active shadowed
thin-leaf scattering. Tree indirect AO currently multiplies material AO by
0.4 + 0.6 * G^1.8 (about0.572 at vertex G=0.5). First measure actual leaf vertex
AO, map colour space and lit/shadowed material state. Then isolate a leaf-only
AO floor0.4→0.7 trial, with bark, lights and shadows held. A separate physical
leaf-scattering trial may follow with actual frontal/backlit/shaded views; neither
is implemented or approved. Do not raise global exposure to compensate, and do
not remove leaf shadows as a shipping treatment.

### Texture and path decisions after the actual wide view

The rock still repeats visibly at its 2.7 m source scale. Its three projections
prevent stretching but do not themselves remove repetition. Ground already uses
two rotated/offset projections; rock currently uses one per axis. Extending that
method to all rock axes would increase packed surface reads from 14 to 20, with
six allocated maps unchanged. That is a candidate to measure, not a free upgrade
or an implemented fix. Do not enlarge UV scale until the scan becomes blurry, or
hide repetition by scattering nonfunctional props over it.

The original research on [stochastic tiling and blending](https://eheitzresearch.wordpress.com/738-2/)
explains why preserving texture statistics matters; naive blending can wash out
contrast. [NVIDIA's filtering discussion](https://developer.nvidia.com/gpugems/gpugems/part-iii-materials/chapter-20-texture-bombing)
also motivates explicit gradients across discrete randomized projections.
Use these as design references, not a claim that this material implements those
complete algorithms. Review close and oblique moving cliffs and measured GPU
time before selecting the extra-sample approach or a better source scan.

Paths still need a genuinely reshaped worn-earth footprint and service clearings,
not another tiny edge-noise adjustment. No road membership may gate movement.
The existing movement test previously passed on controls/network presence with
zero displacement. Its replacement now requires a real visible terrain click,
arrival, actual displacement and intermediate position samples; projection uses
actual terrain height/camera/canvas and fails instead of guessing screen center.
That test is source-checked but has not yet been executed in the native world.

#### Original unqualified proposal and why it changed

After the opacity-only water art check, trial a low, asymmetric cove and sloping
apron within X384–500/Z458–540. Source-derived separation puts this south of the
arena's grading support and east of the southern functional grove; actual route
and slope checks must establish safe clearance. The present high interior
baseOffset 28.15 versus sea16, followed by an 18 m bay bank cut, explains the
raised lawn and excavated bowl. Global height changes or another tiny material
feather would not solve that landform coherently.

Reuse the shared bay coordinates, with metre-scale authoring coordinate
q = halfWidth × (normalizedDistance − 1), not an exact signed-distance claim.
An initial monotone C1 section can pass through (q,height) = (-26,2.5), (-9,16),
(3,17.5), (15,19.25), then meet the existing interior height/derivative near q45.
Trial knot tangents are0/.12/.14/.18/0. Restore the existing height residual
through the normalized mask formulation below, not a post-height overlay.
The earlier17/19 proposal was too shallow to safely avoid the existing global
shoreline steepening rule: its cardinal1m slope test can read a diagonal grade
lower than its magnitude. Keep that shared rule unchanged, measure the final
canonical surface, and require at least.065 cardinal slope around the intended
nearshore route. Also require a continuous3m dry approach with grade at most.4;
the movement system's much larger rejection threshold is not a comfort target.
These are unqualified trial values. Keep the dry shore gently sloping, vary its
width at broad scales, taper into one retained rocky headland, and avoid another
flat shelf. Author in the canonical/emitted-worker landform factory with normal
validated profile/network identity, not a visually disconnected overlay.

Source audit corrects the implementation placement: the existing composed mask
C×B reaches zero near q−17.1…−19.8, and height immediately returns the seabed.
A later modifier would clip the intended submerged section at that old boundary.
Instead locally replace the bay factor, B′=B+W(x,z)×(S(q)−B), then return C×B′
from the shared public mask. W must have compact smooth support; S is a monotone
0–1 section initialized from (targetHeight−floor)/(referencePlateau−floor).
Keep the unchanged outer coast C and explicitly preserve the old expression
outside support. The knots are only authoring targets: original interior relief,
outer coast and shoreline correction still affect final canonical height.
Test continuity across the OLD zero boundary as well as the new zero/support
joins, bounded mask≤C, connected sea and the actual dry route. Do not globally
return C alone: legacy water classification still needs the bay information.
Navigation/grass/resources/bathymetry follow the actual final height threshold;
the separately implemented compute-height algorithm is not qualified by this work.

Acceptance needs changed-region worker/height/normal agreement and smooth joins,
unchanged outside-support/services/resource anchors, real off-road movement down
the apron, correct water containment, regenerated current coastal depth and
low/wide/bay/pond visuals plus an avatar-height walking clip. Check whether the
existing tessellation represents the new section before increasing resolution.
At the time of this original proposal, the unimported CompactCoastalApron factory implemented the bounded five-knot
section/support contract:34 focused checks, project lint/format, shared noEmit
and explicit same-config test typechecking pass. This is not a live sculpt.
Integrate normal profile identity and actual emitted-worker admission together;
structured-cloned recipes must be revalidated/frozen before sampling. No terrain
changes from that first proposal had been implemented or accepted. The current
integrated east-bank correction and outstanding native gates are recorded above.

### Earlier isolated water evidence, superseded by the combined scope above

Native candidate05 completes all four photos, three motion clips, two cost
windows and the actual803²R16F upload/251-point GPU-filter checks. Both reviewers
reject the new cyan cliff outline: connecting the nearshore field to the old
deep-range tint curve produces a painted-looking band. Steep, uniform banks
and repetitive cliff texture still need the substantive sculpt above. Moving
clips retain the cyan band and offshore green topology cracks. All790 pins,
694 archives/seven media verify; browser/services cleanly close. Zero page/GPU/
cleanup errors;19 known cow/dagger errors keep the overall run failed. Evidence:
asset-studio/fine-meadow01/coastal-water-candidate05-verification.json.

Next material candidate restores the exact established ocean tint and uses
local depth only for transparency/contact; it is not physical absorption.
Source qualification04 passes760/760, packing9/9, three type checks and shared/
server builds on106 held pins. Native early-art comparison remains pending,
with motion/cost explicitly unperformed until the appearance merits retention.
Five attempted early-art runs stop before browser startup on local cloud-only
source dependencies, not a demonstrated rendering failure. Exact committed-byte
recovery preserves originals; launch/server preflights now pass. Client pages
serve HTTP200; probe07 subsequently resolves the dependency-scan shutdown hang
with byte-exact recovery and recoverable generated-file quarantine, not a game rewrite.
Retain all failures and do not bypass native review. Detailed recovery evidence:
asset-studio/fine-meadow01/coastal-opacity-art-startup-recovery02.json.
Candidate05 low CPU p95/max29.2/111.1ms and GPU p9515.991ms remain unaccepted;
its low triangle count varies. Bay CPU p9512.7ms does not explain the previous
33.2ms tail or establish a speedup. Runtime/quality settings were not reduced.

The dry-inclusive conforming-edge planner is also source-checkpointed as
f91173a3aa13561010f846c83bd9f547b7d544e7 (27 tests, lint/format, shared and explicit
test typechecking pass). Those historical utility-only checkpoints did not change
running geometry. The current live implementation is described above; native
seam closure, ordinary-player coverage and performance remain required.

Candidate04 clears native renderer/terrain/grass/field readiness, then fails the
capture's30s boot-null wait around85s after navigation (before production120s
deadline). The100% asset-progress curtain does not identify which streaming
subgate holds. Exact readiness/health globals were not retained; add bounded
passive evidence before any correction. No coastal media/cost result yet.
The separate unimported grid foundation is source-checkpointed/pushed as
6e8a0def2ab1f820280dc197b274c94624de9a56; live seam integration remains open.

Candidate03 stops before renderer readiness: requestDevice takes59.314s while
visible/focused RAF continues. No coastal study runs, and cause remains unknown.
Owned browser/services close cleanly; failed receipt is retained. An isolated
actual-r186/Metal first-attempt smoke subsequently initializes in8.2ms with the
same20 device features and2048 array-layer requirement (device0.8ms). This is
permission to continue bounded diagnosis, not native reliability acceptance.
Candidate04 uses the held source and corrected,153/153-preflighted observer;
no coastal appearance/GPU-filter/cost result is yet claimed.

The separate unimported conforming-water grid foundation passes27/27 geometry
tests and independent review: exact world-lattice edge coordinates, refined
corner fans and adaptive index width. It is not a live seam fix. Neighbor edge
ownership, common mesh transforms, actual wave displacement, continuation and
atomic topology transitions still need integration and native cost/motion review.

Native candidate02 clears terrain queues and finishes the actual signed field
in815ms (previous18.434s), with776.8ms sampling,1260slices/max1.8ms and actual
scheduler.yield. Readiness completes unchanged in17.072s during grass convergence.
This is a single-run loading result, not aggregate frame-budget acceptance.
The study stops before media on an observer defect: the actual sampled texture
inherits isSampler, causing a double sampler count. The saved shader has one
coastal fragment lookup. Preserve the failed report and replay the corrected
classification against actual archived shader/binding evidence before retry.
No coastal appearance, GPU-filter or cost comparison has completed yet.

The narrow startup fixes are now source-qualified, not yet native-qualified:
resident queue entries retire before worker-wait without rebuilding owners;
late results reject and content promotion retains the existing count/time budget.
Coastal construction uses optional bound scheduler.yield with a real timer
fallback, retaining the 512-sample cap and every-sample 2 ms check. The target is
per slice, not a hard per-frame cap. Qualification03 passes 760/760 across48 files,
packing9/9, all three package types and shared/server builds on106 held pins
(SHA256 a216358d20f5b4bf85285094af8e18d0468f472a467635c08eb5fe2f5129c77e).
No loading speedup, native queue closure or art/performance approval is inferred.

Native candidate01 failed before coastal media: five terrain generation/worker
keys remained pending for all 108 observations over 30 seconds. The signed field
was current at revision20, but construction took 18.434 s elapsed versus 1.059 s
synchronous work across 1,279 slices (maximum 6.6 ms). This loading cost is not
accepted. A queued-to-synchronously-resident request-retirement defect matches
the source and queue shape; exact native keys/event ordering were not retained.
Fix and test request retirement/content promotion/late results, retain bounded
key diagnostics, then retry with unchanged readiness gates. The failed receipt
is preserved (SHA256 fa35b2955770506ec7ea4cc1944e3de5de0e369d7a6e7b5e05e982addbb58d81).
No coastal GPU-field/media/cost comparison completed. Zero page/GPU errors;
19 known content errors and one missing-media cleanup assertion remain. Owned
browser/services closed, four ports clear, exact database retained stopped.

Current coastal checkpoint: unchanged native baseline02 is complete. Four stills,
three motion clips and two 10-second CPU/GPU windows retain 763 source pins and
678 archives; root independently verified all pins, archives and seven media
hashes before editing production. Report SHA256:
`fb44e0e1c3f3016d39d604b97277ef10fbcd95a8d4fdc8e168e8090019d7d872`.
Zero page/GPU/cleanup errors, 19 known cow/dagger content failures; overall failed,
owned browser/services closed, exact database retained stopped. Baseline01's
incorrect nearby mixed-LOD-edge assertion is retained, not relabeled as a pass.

Still review finds abrupt water–rock contact, an over-uniform cliff/grass lip and
a raised flat-looking lawn. Terrain morphology must improve separately; shoreline
transparency cannot sculpt believable bays, coves, beaches or varied slopes.
The bay window records CPU tick-wall p95 33.2 ms/max 309.4 ms and GPU render-pass
sum p95 13.041664 ms/max 28.18048 ms. The CPU tail grows over several seconds;
cause remains unknown. These overlapping timings are not presented FPS, not
exclusive CPU, and cannot be subtracted to isolate a subsystem.

Decoded offshore frames also reveal green cracks aligned with the actual Z600
mixed-detail water edge. Archived-wave CPU reconstruction finds about 0.24 m
polyline separation between its 6.25/16.67 m grids, up to roughly six projected
pixels; the observer draws no line. The exact exposed green owner is not known.
This requires a separate watertight topology/displacement fix; the first field
candidate deliberately preserves those vertices and cannot close that gate.

The first field candidate is now implemented locally, uncommitted and not
visually qualified. Actual authored ground supplies a signed 803² R16F map;
one complete revision is published after cooperative construction, with stale
lease cancellation, deterministic disposal and explicit streaming readiness.
Only ocean fragment color/opacity consume it, with a 6–8 m static-depth blend
back to the exact legacy offshore optical parameter. Geometry, waves, bounds,
crest foam and elevated ponds stay unchanged. Inactive ordinary ocean materials
still have a disabled 1×1 field binding: legacy optical values, not a claim of
byte-identical legacy shader cost. Initial focused tests pass 71/71; the expanded
actual full-field test also passes all-around coastal rays and independently
solved contact-line comparisons. Final source qualification02 passes 739/739
across 47 files, packing 9/9, all three package types and normal shared/server
builds on 105 independently rehashed pins. The earlier 737/739 test-contract
failure is preserved; updated tests explicitly prove real-edit revision history
and protected/detached grading. Native upload, bilinear filtering, compiled
fragment-only single-sample connectivity, visual/motion and cost comparison are
still required. The following prototype details are historical design evidence,
not the current runtime's loading-time qualification.

Station-edge recovery is source/native verified and provisionally retained for
localized visual improvement. Actual scaled furnace/anvil bounds plus a 1.25 m
working margin replace their inherited grass-only grading halos; four 0.30 m
footing polygons protect the open workshop. Terrain grading, collision, navigation
and path materials remain. Final 673/673 across 41 files, packing 9/9, all three
type checks and shared/server builds pass on 91 held pins; external 111/111 passes.
Strict transport, swept-blade, ownership and native PhysX court tests pass.
A bounded 64-change regional journal keeps ordinary remote edits from renewing
unrelated grass work; overlapping or history-expired inputs retire safely.

Art02 completes three actual WebGPU 1280×720/DPR1 views with 754 pins/669 archives.
Both reviewers retain regained workshop-margin grass and a less isolated shelter.
Deep-shadow spikes, straight boundaries and some overgrown strands remain; this
is not finished grass, motion, navigation, performance or production approval.
All 865 passive points and the two station/21 polygon contract verify. Same 94
cells and source geometry; only cell 13,13 changes instances, 579→771 clumps.
Total 81,290 clumps/3,803,568 triangles/8,806,272 root bytes (+192/+23,040/+36,864).
Recorded installed-owner work rises 23,141,955→23,270,336, not total CPU/frame cost.
Page/GPU/cleanup errors zero; 19 known cow/dagger errors keep overall failed.
Owned browser/services closed; exact DB retained stopped. Art01's incorrect
broadcast-physics observer failure is retained with zero photos, not relabeled.
Replay: asset-studio/fine-meadow01/compact-station-clearance-art02-verification.json.

Next substantive rendering slice: quad-tree ocean currently gives every vertex
shoreDistance=50, so shoreline wave damping and color/opacity ignore the actual
coast. First compare a bounded, signed seabed field for fragment shading only:
the current vertex attribute, wave displacement, mesh topology and bounds stay
exact. Do not claim new wave damping or fix coarse/fine wave seams by simply
substituting vertex depths. Water pitches of 6.25/16.67/50 m are nonconforming.

Sample canonical authored ground, not walkable deck heights or resident-cache
interpolation. Preserve signed values through interpolation; define field bounds,
texel phase, quantization/error limits, outside-deep behavior and exact texture
storage/sample costs before implementation. Publish complete revisions atomically
after real height changes, reject stale work and dispose with the water owner;
no steady-state per-frame CPU resampling. Keep ocean continuation opaque and
elevated ponds unchanged. Optical ranges require explicit calibration: physical
vertical depth is not the existing horizontal shoreDistance convention.

Exploratory canonical-ground probes favor 0.5 m spacing for contact accuracy:
sampled R16F max shallow alpha error was 0.004981, versus 0.01666 at 0.78125 m;
zero-contour displacement was 0.002607 m versus 0.012352 m. These sparse stdout
probes are design evidence, not exhaustive tests, GPU parity or a bake benchmark.
First high-quality candidate: 801² samples across [150,550]×[200,600], with one
gutter on each side (803², centers [149.5,550.5]×[199.5,600.5]). Nominal R16F
texel payload is 1,289,618 bytes, excluding upload padding/driver overhead. Prefer
direct encoded construction over retaining an unnecessary Float32 duplicate.
Qualify independent interstitial/bay/slope/contour samples, full boundary depths,
texel-center mapping and staged generation cost before selecting this runtime.
Use static signed-depth deep blending to exact legacy offshore opacity/color;
nearshore optics may add displaced fragment Y. Do not assume an upper wind bound
from the current default: Wind.setStrength has no maximum clamp.

One full in-memory 803² prototype now completes on the actual canonical sampler:
644,809 finite samples, all 3,208 gutter values exactly 13.5 m, signed range
−32.1820783 to 13.5 m. Generation took 2,991.61 ms (2,934.40 ms sampling);
bootstrap excluding imports was 107.45 ms. These are one exploratory run with
uncontrolled contention, not a GPU bake or loading-time qualification. Its 2,519
cooperative 256-sample batches had synchronous p95 2.229 ms and maximum 8.427 ms;
do not claim a 2 ms time budget from a fixed sample count. Runtime construction
needs time-bounded/cooperative work, cancellation/revision guards, one shared
field and explicit readiness before visual admission. Largest half-float error
0.0302732 m is on a dry hill, not the contact band; test optical regions separately.

The maintained native runner completed a separate coastal-water-v1 baseline
focus: low shore, existing bay overview, wide shore and pond-control stills;
short fixed-camera water and moving-view clips; two real CPU/GPU cost windows.
It must record terrain tracking centers and actual leaf identities: a render
camera rail in preparation mode does not necessarily trigger LOD split/merge.
Pin and verify actual served normal/flow texture bytes, not only shader source.
Baseline holds pushed code7e61599ae/assets6ab6704; its archived source remains
immutable while the local field candidate is prepared. No terrain/nav/resource relocation.
Require actual shoreline/low-angle visuals, decoded motion, spatial LOD joins and
native cost/cleanup evidence; shader connectivity alone is not art acceptance.

Reference: [NVIDIA GPU Gems water authoring](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models)
separates geometric waves from texture detail and uses depth to control shoreline
appearance. The [Three.js r186 backdrop-water example](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_backdrop_water.html)
uses scene-depth/refraction sampling; that view-dependent technique is not a
replacement for the stable seabed authority needed by this bounded first trial.

Secondary water-material observation, not part of the first field change:
decoded public waterNormal.png is 510×511; noise28.png is 1024×1024 with every
pixel R=G=B and alpha255. The present flow graph reads RG as a vector and alpha
as phase, so that source offers diagonal-only vector variation and no spatial
alpha-phase variation. Baseline02 verifies actual served-byte/material-owner
evidence, but that alone does not assign visible motion defects to this file. Keep it
unchanged for the coastal baseline/field comparison; qualify flow detail separately.

The current comparison redistributes the eleven original v6 path radii into narrower
fully worn centers and broader grass/soil feathers, preserving every centerline,
height and outer footprint. The workshop core becomes1.2m with1.65m feather
instead of3.5m with0.5m feather; three connected asymmetric wear strokes remain.
Historical profiles, ground material, geometry and navigation are unchanged.
Exact support/mask domain and CPU/worker/GPU checks pass; three native views show
a modest improvement in narrower junctions and softer edges. Provisionally retain,
not finished paths or meadow quality. Final599/599,9packing, all three type checks,
both builds and107external checks pass. Source receipt is
`asset-studio/fine-meadow01/natural-paths-06-source-qualification01.json`.
Native art01 holds752 pins/667 archives and completes all3 WebGPU1280×720 views.
Direct GPU4,096mask/17vertex checks pass, maxerror0.0000305559/0. Same94 cells/LODs
and source geometry;9 cells change instances,85 stay exact. Total81,098 clumps,
3,780,528 triangles and8,769,408 root bytes: deltas+105/+8,484/+15,456.
Recorded installed-owner grounding work rises23,124,970→23,141,955 units, not
total run CPU work, timing or performance approval. Page/GPU/cleanup errors0;
19 known cow/dagger errors keep overall failed. Browser/services closed; DB
retained stopped. Replay:`asset-studio/fine-meadow01/compact-core-feather-art01-verification.json`.
The initial598/599 source failure retained an old grounded-plaza count; actual
projected1007/pad47/water5/edge0 remain, road22→14 explains retained933→941.
Raw six-leaf sampling and all independent worker/root checks remain unchanged.

The former broad bare-green station padding inherited terrain-flattening support,
roughly 12×12 m and 9×9 m. The completed grass-clearance slice above separates it
from grading. Actual service traversal, moving-blade appearance and native costs
remain open; source eligibility does not identify every pixel or pad rejection.
The previous groundwork checkpoint is pushed as`c6bc0832c`; it is not art approval.

The bounded placement comparison is complete:104/104 focused,485/485 serial,
all types/shared-server builds and91/91 external checks pass. Three native views
retain740 pins and unchanged templates, with80,999 accepted clumps versus81,101
before. Both reviewers see modest evenness improvement only, not a fine-canopy
breakthrough. All page/GPU/cleanup errors0;19 known cow/dagger errors remain.
The owned test browser/services are closed. No new cost/motion/full-load approval.

The 2026-09-14 user review rejects the current world as the target presentation.
The same-quota trial is complete; now deliver a coordinated ground/path
pass: dry grass and earth, credible compacted soil, natural worn transitions and
less stencil-like service aprons. Small feathering tweaks alone cannot repair
the current broad gray gravel patches. Follow with natural terrain/shoreline
shape, the real resource-tree ecology and moving water, judged together in game.
One compact island and one arena; paths must not become exploration corridors.

Decoded packed grass alpha has median0.254902 and99.9801% below the current
0.65 floor. Dirt median0.831373 and rock median0.819608 are materially different.
The connected roughnessNode overrides scalar roughness1, as specified by the
[Three.js node material contract](https://threejs.org/docs/pages/MeshStandardNodeMaterial.html).
A dry-only monotone roughness remap can retain texel variation; keep localized
coast0.58/pond0.62 wet endpoints. This diagnosis does not prove the cause of all
glare, and artistic roughness ranges are not measured material properties.

Qualify [Poly Haven Dirt](https://polyhaven.com/a/dirt), CC0 by Charlotte Baglioni,
at its published2m width as a prospective compacted-earth replacement. Compare
the actual decoded channels and appearance before runtime import; retain the
existing1024px, six-texture/fourteen-sample architecture and test exact channel
packing, provenance, CPU ground-color parity and native sampling. Higher source
resolution alone is not better rendering or a free performance improvement.

Staging now verifies all four original source sizes/publisher MD5s and every
decoded packed channel. Candidate raw roughness mean0.94427 is already dry;
do not apply a redundant dirt roughness remap. Fine soil and small pebbles are
promising, but darker/warmer diffuse and higher fine-grain contrast need native
review at2m scale. Two packed1024px maps total5,140,092B are now installed.
Evidence lives in asset-studio/compact-dirt-material01. The separate exact
current roughness histogram receipt has SHA256
`e5696414fc7ed16065668cbd19d37fdf117bf37a098757617cf5107d1fd2c2f5`.

Source implementation now passes487/487 serial regressions,9/9 packing checks,
all three package type checks and normal shared/server builds on63 held pins.
The initial486/487 run is retained: its only failure was a grass-root expectation
using the old dirt mean; actual decoded-image parity establishes the new mean.
Dry turf uses0.85–0.98 roughness with explicit A/B shader variables. No extra maps,
samples, terrain vertices, grass density or world-lighting changes were added.
Native art01 loaded the maps with745 pins held and zero page/GPU errors, but a
new observer type assumption stopped the matched photos. The actual literal
ConstNodes infer float from numeric values rather than storing nodeType='float'.
Retain that failed run and correct the observer using its raw native receipt.
Owned Chrome/services closed;19 known content errors and the missing-photo
assertion remain recorded in art01, not relabeled as a pass.

Art02 completes three actual1280×720/DPR1 WebGPU images. Both reviewers retain
the finer dry-earth material provisionally: more believable small soil/pebble
scale at the workshop, without obvious new glare, seams or missing textures.
Close/overview change little; this does not solve grass or whole-world quality.
All745 pins and660 archived copies verify. Exact94 cells,80,999 clumps,3,772,764
triangles,8,755,104 root bytes and template/offset/rotation/normal/source-index
bytes match the previous run. Intended ground RGB changes in85 cells. Packed
map totals rise16,267,403→17,071,192B; equal resolution is not equal download cost.
No page/GPU/cleanup errors;19 cow/dagger errors keep the overall run failed.
Owned browser/services close and DB remains stopped. Report SHA256
`60a458db24eb41a80e2a7d5feade3d86435d7969fa8c42cbcae23bf9ebde6fef`;
replay `asset-studio/fine-meadow01/dry-earth-native-verification01.json`.
Full shader connectivity, motion, grazing/backlit roughness response and native
performance remain unqualified. Final external checks90/90 and shape5/5 pass.

The workshop apron is a full-strength3.5m-wide two-point capsule with only a
0.5m transition. Corner cutting cannot make those collinear points irregular.
Its visual bilinear mask/noisy edge and analytic grass-support field differ;
this is a plausible bare-halo mechanism, not a diagnosis of every gap. Next
author a bounded asymmetric worn apron with a genuine wider shoulder, sharing
one descriptor across CPU, worker and GPU mask. Protect actual workspace and
approach clearances, not old decorative outlines. Verify whole-mask texel phase,
all48 resource-tree approaches, water/lodge/floor safety and off-road traversal.
Do not simply widen paint while leaving grass on the old capsule contract.

The next path slice needs explicit per-segment blend width and peak influence
through road records, CPU/worker sampling and both compute kernels. Begin with
connected asymmetric workshop/supplier shoulders while retaining genuine work
cores, not disconnected decorative islands. Previous blade grounding correctly
inverted the >0.8 threshold but assumed a fixed0.5m fade and full-strength peak;
partial-strength shoulders must not inherit that full-strength exclusion.
Verify the actual >0.8 exclusion envelope, complete
bilinear mask footprint and positive off-road routes, not just endpoint samples.

Read-only navigation review finds no road-membership gate in authoritative
player walkability. Current gates are water, slope, building/bridge transitions
and object collision. Existing real-world BFS tests cover resource/service
access but not an explicit whole-island off-road census; add that evidence and
live traversal as the island fills out. Do not delete valid collision checks.
All scene-wide visual, water-motion, workload and production gates remain open.

The first path implementation now adds three connected fractional-wear strokes
around the workshop/supplier, preserving all eleven earlier records. Explicit
fade/peak reach CPU, emitted worker, grounding and both GPU kernels. Full
support checks cover301 segments,45,700 ground samples, all48 tree-model
envelopes and real off-road service routes. The full256 mask shifts its centerX
359.55→359.171875; preserve the old4684-texel baseline on its own grid. On the
new grid, the original eleven occupy4693 nonzero texels and wear adds179, for
4872 total. This is a mask-domain rephase, not unchanged distant path pixels.

Final source qualification passes598/598 across37 files, packing9/9, all three
type checks and normal shared/server builds with80 held pins; external checks
pass102/102. GPU vertex-count uniforms now store actualu32 counts, and pooled
readback returns only requested bytes. Actual GPU/kernel checks now pass; the
three-view review finds no decisive visual gain. Retain earlier failures and the independently proven stale
grass census: HEAD216d12fd and current emitted workers match all twelve inputs
and five buffers, including529 not the older532 in a cell with zero roads. The
origin of that older recorded difference is unproven; do not blame the new wear.

Native art01 holds752 pins/667 archives with three1280×720/DPR1 WebGPU stills.
Direct production-class checks pass4,096 mask values (maximum error0.0000504592)
and17 vertices (error0, exact68B readback). Only cell13,13 changes580→574 clumps;
the other93 retain exact logical geometry, instance/root bytes and bounds.
Eight unsigned-index storage-width variations are independently reconstructed,
not mislabeled identical raw bytes. Templates remain exact; totals are80,993
clumps,3,772,044 triangles and8,753,952 root bytes. Report SHA256
`38fd8fe562711a3e1ff457f49dae182f0c94f433632acd5a3a28cde331ebf523`;
offline replay `asset-studio/fine-meadow01/compact-natural-paths-art01-verification.json`.
No page/GPU/cleanup errors;19 known cow/dagger errors keep overall failed.
Owned browser/services closed, exact database retained stopped. No new motion,
native cost or sustained-load qualification. Both reviewers find the additional
skirts too subtle: broad brown cores and bare-green margins still dominate.
The dry earth remains matte without an obvious new map/glare/seam defect.

This is verified groundwork, not a demonstrated art gain or a solution for the
broad original cores. Next redesign genuinely oversized service
footprints as narrower trafficked cores plus asymmetric low-intensity shoulders
within verified clearances. Do not simply append more painted area. Partial
wear still changes acceptance/RNG within affected grass cells; no unchanged
population, cost, lush coverage or production-quality claim follows from tests.

## Thin-leaf native comparison — no visual promotion

The fine-only SSS candidate passes51/51 source checks, all three package type
checks and normal shared/server builds. After retaining and correcting three
failed capture attempts, external preflight passes89/89 and art04 completes
three actual daylight PNGs,80 compiled shader pairs and94 material owners.
All740 pins stay held;655 archived source copies and three images replay.
Overall exit1 remains for19 cow/dagger content errors; page/GPU/cleanup errors0,
owned browser/services closed and database retained stopped.

Root and independent review find no decisive improvement over near3: angular
flat strips, sparse bristles and exposed ground still lack the reference's lush
overlap. All measured views are oblique, not backlit; the intended translucency
benefit remains unproven. Do not promote this uncommitted opt-in experiment or
infer runtime cost from the stills. Next evaluate same-quota stratified clump
placement shared across CPU/worker, with real exclusion/grounding checks,
seam/regularity review, coverage evidence and native cost. Keep the40m versus
original80m dense-tier distance as a separate explicit cost/quality decision.

## Restored-three native follow-up — scoped pass, canopy/performance still open

The unchanged restored-three source completes `fine-grass-near3-rail-target01`:
three daylight views, native geometry/root checks, wind, actual LOD0→1→0,
exact post-return source/root bytes and final scheduling. Target-only passive
telemetry records both jobs finishing ready; it does not establish why the
earlier near4 rail failed. External preflight passes81/81. Overall exit1 remains
for missing cow assets, with dagger fit still blocked; cleanup is clean.
CPU p95 campus/close19.80/18.50ms and GPU pass-sum p9529.10/28.70ms are
diagnostic windows, not presented FPS or an isolated restoration speedup.
Close and overview grass still lack the reference's fine overlapping canopy.
Do not promote the art or hide its cost; investigate light response and real
canopy coverage instead of another small taper or unproven scheduling rewrite.

## Current near4 decision — reject added geometry; recover canopy, not just curves

The extra close-range segment passes independent geometry/root-addressing/wind
checks and reaches actual WebGPU screenshots and motion capture. Root and
independent comparison find only a small bend improvement: broad lower strips,
gaps and muted shading still miss the supplied soft, overlapping meadow. The
extra 48 triangles per near clump do not earn promotion on this evidence.
Restore the three-segment selection, retain the experiment, and focus on canopy
coverage, ground-to-blade integration and coherent shading without a hidden
density, resolution or quality reduction.

The complete attempted native diagnostic `fine-grass-near4-daylight01` is failed,
not approved: daylight wind completes, but the out/back rail observes LOD [0]
instead of [0,1,0]. GPU render-pass p95 is 28.64/28.31 ms and CPU tick p95
21.80/22.20 ms across campus/close windows; these are instrumented observations,
not presented FPS or a measured near4 delta against a matched current baseline.
Serial regression also exposes one existing dense-baseline active-budget failure
(458/459). Preserve these launch gaps; do not treat 139/139 focused tests,
79/79 harness checks and successful builds as visual/performance approval.

## Current substrate verdict — quieter ground retained; blade quality remains open

Fine-only grass albedo now retains 35% of scanned RGB variation around the
unchanged raw linear source mean, before optional meadow tint, grading and
ground-layer blends. Root and independent seven-image review retain it as a
narrow improvement: less distracting ground grain, especially close up and in
the anvil shadow. Cleared patches risk looking painted flat; residual texture
remains. Angular separated strips, visible stems/gaps and insufficient canopy
overlap still miss the user's reference. No overall meadow/AAA approval.

The source mean remains fixed; this is whole-albedo contrast, not spatial
filtering. Texture resolution/physical scale/samples, normals/AO/roughness,
non-grass blends, grass geometry, placement and quality settings remain held.
The reference's camera/version/settings are unknown; live actors and wind vary,
so no pixel-matched reference or quantitative coverage improvement is claimed.

Focused tests pass 45/45. An initial 44/45 failed only the new exact arithmetic
assertion (0.06 versus 0.05999999999999994); it now uses 1e-14 tolerance without
changing prior gates. That focused failure remains in tool history, not a
fabricated log artifact. Broad serial regression passes 445/445 over 28 files
(`substrate-contrast-integration01.json`, SHA-256
`500c0300651fb91e0ae768e0bb0af8df2d3240618aa9cf6922f6598dece192ad`).
Shared/client/server noEmit, shared bundles/declarations and the normal server
build pass; competitive manifest prefix `2cbc9468ff2a`. Native uses the Vite
development client plus rebuilt shared library, not a new client-dist/root build.
The prior concurrent 439/441 active-budget failures remain unresolved; this
albedo-only pass did not repeat concurrent tests or claim to solve load cost.

`fine-grass-substrate-contrast-art01` ran 2026-09-14 03:09:06–03:11:24 UTC.
All three native 1280×720/DPR1 Apple Metal/WebGPU images completed, with 36 receipts
and all 731 source pins held. Overall exit 1 / passed=false / studyPassed=false
remains: five cow-model/404 errors and 14 retained dagger-fit errors. Page,
GPU/device and cleanup errors are zero. Report SHA-256
`54238d7cdf4e2e41da24faa155d0b955489dd61fb60b1a9a78d593bfda023657`.

Root independently replayed 82 actual main-context grazing shader pairs. Removing
only the two new declarations/two assignments and restoring the grade input makes
the entire observed terrain fragment shader byte-identical to lateral-sweep-art01,
without identifier or whitespace normalization. Vertex WGSL is unchanged.
All 94 same-LOD owners, source indices, templates and ten attributes remain exact:
81,101 clumps / 3,780,636 triangles / 8,769,696 root bytes; 14,230,352 attribute bytes
including 3,490,040 instance/root scalars were compared. No population cut.
Replay receipt `substrate-contrast-native-verification01.json`, SHA-256
`3c9f323ace1c1450726471f782485a6580d9c8f07a251670a885b159f15b1ed7`.

Owned browser/services close; PIDs 31829/31860/32022/32023 are absent and ports
3333/5555/9236/57831 clear in independent checks. PostgreSQL is retained exited(0).
No real wagers, streaming, cost probes, wind/LOD rail, sustained frame/memory/load
or deep CPU parity were performed by this three-still diagnostic. Those gates
remain open. Independent visual review `substrate-contrast-art01-review.md`,
SHA-256 `2ad1d90217aea6719a4b0d468d65c9ec41268a0ed7e8f4c48b06e1abcb4d73ed`.

The preceding lateral-sweep/grounding checkpoint is pushed as
`bff5070a6f797c801aa5668ffe509e79ca61c4d3` under dreaminglucid, exactly seven
files with normal hooks. This substrate checkpoint's commit/publication status
is tracked separately in the external fine-meadow COMMIT_RECEIPT.json.
Following this visual checkpoint, an uncommitted exclusion-check allocation
candidate passes 59/59 focused and 452/452 serial, but concurrent load still fails
449/452. All type checks/builds pass; no native run after that candidate or measured
speedup is claimed. A real single-file V8/worker profile (19/19 tests) points toward
continuation/geometry work for the next measured investigation. Full receipts and
limits are in the external fine-meadow QUALIFICATION.md. Continue close-view blade
curvature/overlap work separately; these remaining art and cost gates stay open.

## Previous sweep verdict — modest shape improvement; grass quality remains open

The fine-only arc ratio is now 0.48 instead of 0.30. Blade heights, width,
linear taper, configured density, LODs, wind, materials and lighting stay held.
Root and independent review retain the broader sweep provisionally: more
crossing, bent tips close up, but little overview improvement. Flat lower
strips, segmented bends, exposed granular ground and the gap to the user's
soft continuous meadow remain. Do not keep increasing arc by default.

`fine-grass-lateral-sweep-art01` ran 2026-09-14 02:17:03–02:19:20 UTC.
It completed three actual 1280×720 nonfallback Apple Metal/WebGPU images and
37 receipts with all 731 source pins held. Root independently replayed all
80 observed main-context grazing shader pairs. Page, GPU/device and cleanup
errors are zero. Overall exit 1 / passed=false remains for five cow-model/404
errors; 14 bronze-dagger fit errors remain separate production blockers.
Report SHA-256: `135d49e8ecbadf09c4ca83300b02e3ee05b2f0bcf20f33260c3b89dababb671a`.

The wider envelope removes 174 previously accepted clumps across 17 of the
same 94 same-LOD owners: 126 additional pad rejections, 47 road and 1 water;
terrain-edge rejections are unchanged. No new sources are added. Current
81,101 clumps / 3,780,636 triangles / 8,769,696 root bytes compare with the
linear baseline's 81,275 / 3,795,468 / 8,796,192. Root verified **3,490,040
common-survivor instance/root scalars exactly**, not just population totals.
This is legitimate wider-envelope exclusion, not a configured density cut
or a speedup claim. Motion, wind/LOD rail, deep CPU parity, cost and sustained
frame/memory/load qualification were not performed by this three-still run.

Focused geometry/wind/grounding checks pass 75/75; the broad serial regression
passes 441/441 across 28 files. Shared/client/server noEmit checks, shared
bundles/declarations and the server build pass; the competitive manifest was
regenerated normally (prefix `30e70fe9754e`). This uses the real Vite development
client and rebuilt shared browser library, not a new client-dist/full-root build.

The default-concurrent run still fails **439/441**. Two existing non-fine
1,848-clump jobs retain valid leases but exceed the unchanged 250 ms active
budget (250.004911 / 251.867921 ms; maximum slices 13.25475 / 17.232417 ms).
They publish nothing. The prior transform-reuse checkpoint's concurrent and
serial 441/441 passes do not establish a reliable fix; keep every failed run.
Next cost hypothesis is avoiding polygon-generator allocation for distant
AABB misses, preserving exact yield/charge ordering; it is not implemented
or measured. Next art hypothesis is fine-only substrate color microcontrast,
also separate and not implemented.

Owned browser and services close; all four ports and recorded PIDs
28703/28736/28900/28901 are absent. PostgreSQL is retained stopped.
The source changes remain an explicit experimental candidate, not a default
promotion, finished meadow, AAA or production-performance approval.
Independent image review: `lateral-sweep-art01-review.md`, SHA-256
`02e4547fcf39c2501554eaf0e90d51278786ac6da3320b73fc5c92fd387467ee`.

## Current verdict — modest finer silhouette, full grass quality still open

Linear-taper art02 shows a modest improvement over the wider gain baseline:
finer upper ribbons, with no obvious large coverage collapse. Root and independent
review retain that direction provisionally, not finished grass or a reference
match. Stiff nearly straight sections, limited tip layering/overlap and grainy
exposed ground remain. The reference's softer continuous canopy is still the goal.

After Mac unlock, art01 failed before rendering on a stale competitive manifest;
normal server rebuild resolved that prerequisite without bypass. Art02 completes
three real PNGs/37 receipts with731 source pins held and zero page/GPU/cleanup
errors, but overall exit1 remains for five cow/404 errors and14 dagger-fit blockers.
Actual nonfallback Metal/WebGPU at1280×720/DPR1 keeps the same81,275 clumps,
3,795,468 triangles and8,796,192 root bytes as gain-art02. Normal/UV/index bytes
stay exact; positions restore the archived linear templates. Owned browser and
services close; PostgreSQL is retained stopped. Structural parity is not cost,
wind/rail, deep CPU, full art or performance approval.

The linear candidate is still uncommitted/unpushed; f4df79 remains the last pushed
color checkpoint. The next visual questions are centerline/tip bend and overlap,
not further narrowing by default; ground grain remains a separate variable.
The bounded failure-only grounding diagnostic passes19/19 focused tests. Its
28-file parallel rerun fails438/439 and identifies active_cpu budget exhaustion
at251.01175ms with valid terrain/input leases and no publication. Earlier
uninstrumented failures are not retroactively explained. Actual work/cost must
be reduced and checked under concurrent, serial and browser workloads, keeping
original budgets, placement checks, population and output fidelity unchanged.
All earlier failures remain retained and the goal remains ACTIVE.

## Previous gain verdict — retain color only; finer silhouette next

The three real gain-art02 daylight images are a provisional COLOR improvement
over rejected white addition: richer greens and less mint/frost, with dark roots,
tree shadows and service clearings still visible. Root and independent review
do not approve the full grass appearance: broad angular ribbons, upright bristles
and exposed granular ground still miss the reference's fine overlapping canopy.
Different wind/agent poses and unknown reference settings preclude an exact A/B.

The three-file source checkpoint `f4df79a72e1d2e4e756c5c38fa3251644cb84687` is
pushed on `codex/sol-duel-stream-launch` under verified dreaminglucid identity,
with normal hooks and all three tested hashes held. Gain-art02 completes its
three-image art scope with37 receipts,731 unchanged source pins and83 observed
compiled gain shader pairs, but exits1 for five cow/404 errors;14 dagger-fit
errors remain production blockers. Page/GPU/cleanup errors are zero, owned
browser/services close and PostgreSQL is retained stopped. None of this is a
full-study or performance pass; cost, wind, rail and final scheduling were omitted.

Next comparison implemented, uncommitted and not visually qualified: an isolated
fine-only .85 linear taper with color, centerlines/heights, geometry counts,
population, normals/AO, maps, lighting/shadows and functional exclusions fixed.
Reduced strip area can worsen ground exposure, so judge close silhouette and
overview coverage separately; final bend is a separate later variable if needed.
The art-only harness now labels source-pinned shape policy explicitly; fresh
preflight passes72/72 with all gates/limits retained, not a new native result.
Keep the color direction
provisionally, not the complete grass result. No default,
full grass-art, motion/LOD, performance or production approval; goal remains ACTIVE.

Current linear source gates: focused01/02 each pass24/24; scoped format/lint/diff
and independent provisional-trial source review pass. The regression restores
archived geometry bytes, not newly chosen golden hashes. Parallel integration01
passes437/439; two non-fine grounding assertions fail with0 rather than1, exact
job state/cause unknown. With unchanged code/assertions/timeouts, serial02 passes
439/439 across28 files in51.446547s, matching the previous gain's serial mode.
Preserve the parallel failure; this is not a proven concurrency diagnosis.
Shared build01 now passes exit0, including all bundles/declarations; all owned
offline sessions are closed. The linear native comparison awaits Mac unlock:
automatic unlock is unavailable, user notified. This is the first current lock
audit and the goal remains ACTIVE. Source/test/build/harness/docs are frozen;
no new native run, commit/push or appearance/performance approval. The parallel
failure remains unexplained, not harmless on the strength of serial success.

## Previous recovery gate — resumed ACTIVE; launch validation passed

The goal resumed ACTIVE at2026-09-14 00:05:10 UTC: fresh cloud-audit turn1 with
meaningful recovery, not the prior three-turn blocked audit. All203 top-level
scripts/scripts/lib `.mjs` files are resident at00:06:23.443. The7,628B bow receipt
and16B pre-commit hook also became resident at00:09:41 after exactly one renewal
of each inactive request; no unread content was replaced. The temporary unsigned
iCloud Drive fallback tab is closed, with no Sign In click, authentication,
account change, web download or other browser-data read. Physical disk has34GiB
free; this is not a full-disk finding.

Standalone launch-asset validation02 then failed its unchanged15s byte-read
limit on `iron_arrow.iconPath`, `asset://icons/arrows-base.png`, not an established
authored-asset defect. The arrow icon is now resident after a bounded20-file icon
request; all17 current requested icons are resident at00:15:08. Validation03 then
failed the unchanged limit on `emotes/emote-idle.glb`. Of the validator's44 exact
essential assets, the6 requested emotes/638,100B also became resident, with no
backup names in that batch. Unchanged launch validation04 passes exit0 at00:18:24:
4 areas,28 resources,18 NPC definitions and6 station types. Keep01/02/03 failed.
The normal three-source/test-file commit remains live with verified dreaminglucid
identity. Pre-commit backup/format/apply/cleanup passed and all three source hashes
remain held afterward; commit-msg now awaits a39B cloud-only hook wrapper.
Seven other wrappers were requested once, without repeating its active request.
No hook bypass/content replacement or commit/push success. Existing439/439 is
prior-audit evidence; no new source/build/native change occurred. Docs freeze
with the commit pending before gain-art02. Keep the reference's fine overlapping
canopy as the art target; no visual/performance gate or standard is lowered.

## Historical development — reject white addition; test chroma-preserving gain

Three actual grazing-art01 views show stronger upper-canopy highlights, but
the .12 white addition turns strips pale/frosted and loses rich greens. Root and
independent review reject that exact treatment. Roots/tree shadows remain dark,
yet exposed granular turf and broad blade silhouettes are still unresolved.

Source now replaces white addition with a bounded proportional gain: multiply
existing blade albedo by 1 + .35 × grazing³ × the same root mask, then cap RGB1.
Below saturation this preserves channel ratios. Keep the same fine/compact-PBR
guard and all geometry, population, normal/AO, textures, lighting and quality.
This remains an unaccepted art candidate, not physical transmission or emission.

The previous run's shader-string mismatch is understood and 85 actual native
shader pairs replay correctly after correcting vec3 constructor spelling. The
run still failed: its page navigated again during teardown, erasing observer
state. The initiator is unknown and original equipment/device cleanup unproven.
OS processes/ports are clear; database retained stopped. Bounded passive
navigation evidence is implemented; external checks pass72/72. Live telemetry
and current gain emission/art remain unverified. The focused test initially
could not initialize because iCloud had offloaded a pinned build dependency;
exact-file download recovered checksum-verified bytes without changing versions.
Scoped format passes. Blade silhouette and coverage remain explicit concerns
independent of this albedo experiment; current recovery results follow below.

After exact dependency recovery and real manifest hydration, focused material03
passes 39/39 checks in 1.45 seconds. Earlier failed/interrupted runs are retained.
Earlier integration/lint/type/build attempts encountered cloud-offloaded files;
interrupted runs and the initial failed reinstall dry run remain historical, not
passes. Mac access and required files were subsequently recovered. The original
dependency directory is retained recoverably at
`asset-studio/dependency-recovery-20260913-1bTUqyg1/node_modules` after interrupted
reinstall01; frozen, scripts-disabled reinstall02 passed6,755 packages in29.40s.
Root lockfile, four manifests, Three patch and all six patched Three runtime
files remain exact. No source, version, timeout, lint or quality gate was changed
to bypass the issue, and no account/storage setting was changed.

Post-repair integration04 passes439/439 across28 files in51.966864s. Scoped lint05,
all three noEmit checks (shared04/server02/client02), and shared/server production
builds02 pass. Client configured Vite build02 also passes exit0 after11,361 modules
and14m32s including cloud hydration; it is not the full root Turbo wrapper.
All six requested public assets are resident and all owned verification/hydration
processes are closed. All three tested gain source hashes remain held. Fresh
capture preflight03 passes72/72 in15.66088625s with unchanged harness hashes.
Pinned native prebuilds and real local runtime smokes pass. Separately, the local
macOS FFmpeg vendor binary reports6.0 with `--enable-nonfree`; production artifact
and distribution qualification stay open, with no encoding/distribution done.
This finding does not establish the production Linux stream's binary.

The subsequent frozen gain-art01 attempt closed exit1 before server/browser
startup: cloud-only launcher/preflight imports exhausted the unchanged185s bot
wait. No gain images or live study receipts were produced. Sources stayed exact
across720 pins; no Chrome/PostgreSQL was created, and owned PIDs/ports are clear.
The null-launcher and missing-actual-art-delivery cleanup assertions remain in
the failed report, not waived. Standalone launch-asset validation01 then failed
its original15s byte-read limit on the cloud-only certified bow installation
receipt, not a proven authored-data defect. No owned runtime process is active.
Await that already-downloading file and validate02; the finite61-file scripts/lib
batch is also requested, not yet proved complete. Verify launch readiness before
the next three-view native comparison. The goal stays active; no current-gain
GPU/art/performance approval, source edit, commit or push is claimed.

Next silhouette hypothesis: current shoulder taper preserves88.9% root width
at44.3% authored height, contributing to the broad-strip appearance. A fine-only
legacy taper could slim the lower/middle blade without adding geometry or
instances, but loses about13.77% near/12.5% mid strip area and may expose more
ground. It is not implemented. Existing open-meadow residency is near its
placement ceiling; retain road/workstation exclusions rather than filling them
with decorative grass. Close-view beauty, overview coverage and motion remain
distinct acceptance gates.

## Historical trial — restrained additive fine-meadow grazing response

The next isolated canopy hypothesis is implemented in the explicit fine appearance
on compact PBR only. A guarded world-space view direction produces a cubic
grazing response, multiplied by a .05→.65 UV-height root mask and capped at .12
additive linear RGB. The resulting albedo is capped at 1 before unchanged PBR.
This is stylized reflectance, not emission or physical transmission. Dark greens
can wash out disproportionately; test the actual images rather than assuming
the old rim's removal explains the supplied reference, whose revision is unknown.

Keep the existing geometry, population, .20 normal blend, root AO, wind/grounding,
textures, restored substrate response, light/shadows and render quality fixed.
Use the active render-camera built-in for reflection correctness. No extra
texture/pass or custom camera uniform is introduced; actual compiled interface
and cost still require verification. Root joins, canopy depth, highlight bands
and tree shadows are explicit visual gates. Ground-albedo contrast is separate.

Actual material/appearance checks pass 39/39 and integrated checks 439/439 across
28 files. All source builds and scoped lint/format pass; external capture
preflight passes 69/69. New native shader connectivity and imagery remain pending.
Save the same three native daylight views before any long run.
Only a convincing art improvement warrants full motion/LOD/performance
qualification. The final publication race and cow/dagger defects remain open.
Source-backed history: `asset-studio/fine-meadow01/grass-grazing-highlight-history01.md`.

## Current verdict — reject normal-only trial, 2026-09-13

The three real substrate-art01 images do not show a convincing improvement over
shoulder02. Root and independent review still see granular exposed ground and
broad flat strips; the reference's soft continuous meadow remains unmet. The
original grass normal strength 1 is restored and the experimental scalar/routing
removed. Both production files match pre-trial 7d1f46db2 byte-for-byte; retained
material tests pass 41/41 with scoped lint/format. Restored integration passes
436/436 across 28 files; all three package typechecks/builds and 68 corrected
capture-tool preflight checks pass. Keep the failed report and images as evidence,
not an art pass; no post-restoration native run is claimed.

The short native run saved all three PNGs, then failed its scalar observer:
installed r186 has an extra intent VarNode before the ConstNode. Archived terrain
WGSL confirms the .25 scalar was assigned and used by both grass projections.
The observer defect does not explain away the weak art result or convert the
failed run into a pass. GPU/page errors were absent; cow/dagger content failures
remain. All owned processes/ports are clear and the database is retained stopped.
Cost, wind, LOD and final scheduling were deliberately not qualified here.

Source history provides a more relevant next experiment: commit b6b3af00e removed
the old shared grazing-angle highlight from compact PBR grass. The current
root-tip gradient remains. Test restrained fine-only, root-masked grazing fill
before unchanged PBR, with geometry, density, height, maps, resolution, lighting
and shadows fixed. Do not restore the old cool tint or emissive output. This is
an explicitly stylized reflectance trial, not physical translucency or a proven
explanation of the reference, whose exact revision/settings are unknown.

Review the same three stills before another full qualification. Ground-albedo
grain and canopy gaps remain separate concerns; do not silently combine more
changes. Shortening current blades also narrows them, so height changes require
explicit coverage review. No art/default/performance or production approval.

## Historical trial — fine grass substrate normal response, 2026-09-13

Implemented the planned isolated grass-normal strength 1→.25 in the existing
opt-in fine-meadow presentation. Both derivative-aware grass projections share
one named scalar; ordinary grass remains 1, dirt .25 and rock .4. Albedo/CPU
color, source maps, texture dimensions/filtering/sample count, roughness/AO,
blending masks, grass geometry/density, grounding and lighting stay unchanged.
This is a disclosed art-strength change, not a texture-resolution reduction.

Actual material arithmetic/routing tests pass 41/41, including near/fade/far
distances and protected other-layer/non-normal channels. Integration passes
436/436 across 28 files serially; all three package typechecks/builds pass.
Scoped lint/diff and 67/67 short-capture preflight checks also pass.
Initial test-helper traversal and repeated-DAG-evaluation failures are preserved
and corrected without raising a timeout. Independent source review finds no
scope or lifecycle blocker. Native pictures are still pending.

The explicit three-still art capture must save the same naturally daylit
close/elevated/anvil views and preserve native source/owner evidence and cleanup.
It must report its omitted cost, wind, LOD and scheduling gates as unperformed;
it is not a full-study pass. Inspect the pictures before another long run and
reject a painted-flat substrate or no worthwhile improvement. Existing full
qualification and its failed final snapshot remain separate. No default change.

## Latest verdict — shoulder canopy remains a comparison, 2026-09-13

Actual shoulder-native02 close/elevated/anvil images show modest extra overlap
but also broader, flatter leaves over conspicuous granular turf. Root and
independent review do not accept it as the reference-quality grass finish.
Keep the pushed candidate experimental; do not widen the blades again on the
assumption that width alone solves canopy continuity. The original reference's
exact camera, lighting and configuration are unknown, and the captures differ
in actor/wind state; this is an art judgment, not a pixel-isolated experiment.

The native scene-study routine captures all three views, daylit wind and the
out/back LOD rail. Overall qualification still fails a post-study publication
race: one grounding job finishes between fresh published/live reads, changing
job count and correction bytes. Do not waive those structural fields; a future
bounded quiet/stability retry must retain the existing deadline and invariants.
Cow/dagger content failures remain. All owned processes/ports are gone and the
exact database is retained stopped. Source tests/builds stay qualified, not art.

Observed campus/meadow CPU p95 is 16.9/14.1ms and GPU-pass-sum p95 is
19.92/17.89ms. Actual grass draw/triangle sets match grade-native03, but differing
sun phase and moving scene content prevent an isolated causal cost comparison.
No presented-FPS, sustained performance or hardware approval follows.

Next use the same three native stills as an early art gate before another full
motion run. First test grass-only normal relief 1→.25, keeping all texture bytes,
filtering/resolution, albedo/CPU sampled color, roughness, geometry, density,
lighting and soil/path/rock layers unchanged. This targets distracting grain,
not geometric holes; reject it if the turf becomes painted-flat. A mean-preserving
grass-albedo contrast treatment is a separate potential follow-up, not silently
combined with the first comparison. Preserve actual layer-isolation checks.

The primary [GPU Gems botany chapter](https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-1-toward-photorealism-virtual-botany)
discusses coherent terrain/grass lighting and balancing apparent volume with
rendering cost. It informs this visual relationship, not an adoption of its old
billboard implementation or a claim about present WebGPU performance.
Evidence: `asset-studio/fine-meadow01/QUALIFICATION.md` and the independent
`shoulder-native02-art-review.md`. All historical notes below remain historical.

## Current grass candidate — shoulder taper and root depth, 2026-09-13

The fine-only candidate now uses width(t) = maximumWidth × (1 − t²): fuller
upper leaves at the same roots, maximum width, height, centerlines and tips.
Analytical strip area rises 15.97% near /14.29% middle without adding blades,
attributes or triangles. This is not measured pixel coverage; wider leaf edges
can change swept-clearance survivors and raster cost. Fine-only root AO rises
smoothly from .55 to 1 over UV height 0–.6, reducing indirect fill rather than
albedo or direct sunlight. Existing .20 normal blending, grade, wind, textures,
resolution, shadow quality, resources and service exclusions remain unchanged.

The source passes 426/426 affected integration checks across 26 files serially,
including 24 appearance, 12 material/wind and 34 actual grounding checks. All
three package typechecks/builds, scoped lint/diff checks and 64/64 external
capture checks pass. Archived old geometry and all lower profiles remain explicit;
independent source review found no blocker. Native compiled AO, matched views, moving LOD and cost are
still pending. Judge against the reference's soft overlapping meadow, rejecting
black roots, bands, coarse leaves and seams. No visual approval or default
promotion follows from these source checks. The following sections retain the
earlier observations as history, not the current implementation state.

## Grass reference correction — next art priority, 2026-09-13

Current checkpoint: grade-native03 passes the focused native study after the
shared sampler fix. Exact source closure, installed color/projection parity,
terrain/main and observed reflection ownership, all three daylight stills,
fixed wind, revisited LOD/root/bounds and the bounded final publication fence
qualify locally. The overall run still fails the missing cow model/content
gate; fourteen dagger fit errors also remain production blockers. This is not
art, performance, default-promotion or launch approval.

Root and independent review provisionally retain the greener grade, but reject
the current canopy against the reference: thin upright separated ribbons still
expose too much granular turf. The elevated view confirms the gap. Keep fine
blade count, height, width and render quality fixed initially. Exact geometry
review shows arc .30→.45 moves a representative blade's rows only 1.1/4.3/9.8 cm,
with the largest shift at the zero-width tip; it does not create a drooping leaf.
Plan a stronger visible upper-leaf shape/shading comparison before another long
native qualification. No new shape is implemented. Actual sweep/support/service
access and both LODs must be requalified, with any extra rejected clumps disclosed.

Native03 CPU p95 is 15.1/15.8 ms and queried GPU-pass-sum p95 is 18.68/17.63 ms
(campus/meadow), not presented or sustained FPS. The meadow cost probe occurs
later in the daylight cycle than the strict photo/motion band: no matched-light
speedup claim. Both videos decode cleanly at 1280×720 (239/354 frames), but sampled
frame review does not approve subtle shimmer or invisible LOD transitions.
Evidence: `asset-studio/fine-meadow01/QUALIFICATION.md` and the unchanged
`fine-grass-grade-native03` native capture. Source checkpoint `6f822cab493087d9fbbb1f81df63bdc98816d466`
is pushed under `dreaminglucid`; the candidate remains opt-in.

Prerequisite history: grade-native02 exposed a real sampling inconsistency,
not an accepted color result. Once the actual terrain noise texture was created,
CPU grass sampling switched from analytic noise to quantized bilinear texels;
the emitted worker did not. The reproduced off-center cell was 218/218 clumps
before initialization but CPU223/worker218 afterward. The correction now shares
one deterministic sampler, preserves existing GPU texture bytes, and explicitly
requalifies changed worker placement. Do not replace the observer with a matching
approximation or waive actual color/placement parity. The saved failing run and
new regression are evidence of the defect, not a visual upgrade.

The shared sampler correction now passes 416/416 checks across 26 files in a
serial run, all three package typechecks/builds and scoped lint/format. Old
analytic worker counts/hashes remain as historical data beside strict corrected
oracles and stronger byte-exact CPU/worker comparisons. A concurrent 415/416 run
hit the existing 250ms grounding guard; preserve that failure and retain the
limit. Native load/performance is not approved by the serial source pass.

Reference comparison against native07's restored .20 material still identifies
upright, separated ribbons and exposed granular turf as the principal shape
gap. The earlier arc .30 to .45 suggestion is now downgraded to a modest possible
silhouette experiment after source review; it is not a likely fullness remedy.
Neither that change nor a replacement upper-leaf shape is implemented or approved.

The .12→.36 height-dependent normal trial is **rejected as a visual upgrade**.
Native02 captures matched meadow/anvil views and both naturally daylit clips;
root and independent review still find flat olive ribbons over exposed granular
turf, without a convincing gain in canopy depth. Restore the exact simpler .20
material while retaining expanded normal/geometry tests. No geometry, density,
palette, wind or global lighting change belongs to this rejected trial.

The explicit focused study completes shader/root/binding, terrain/tree, cost,
wind and full revisited-LOD checks. Overall native02 remains failed because a
periodically published cumulative grounding timer trails its live read by 7.6ms;
that reporting assertion needs a bounded correction, not another blind rerun.
The two views and clips are not the omitted full equipment/architecture scope.
All failed archives remain intact; no art/performance/default promotion follows.

Next color trial: compare a grass-only linear grade shared by the actual terrain
grass layer and CPU blade-color sampling before soil/path/rock blending. Current
scan mean [.12687,.16117,.03426] is deliberately more olive than legacy forest
[.12597,.23302,.04696]; current green is 30.8% lower. This is not a demonstrated
gamma fault, and the old reference's exact configuration remains unknown.
Preserve raw scan provenance; explicit artistic grading must test CPU/GPU parity,
texel clipping, exclusions and actual views. The [.95,1.30,1.10] versioned
`fine-meadow-green-v1` candidate is now implemented in the existing explicit
fine-meadow pair, not a new query or default. Startup selection is cached across
async loading; terrain, CPU fallback and emitted worker share it and reject stale
result echoes. Material checks pass 38/38, focused propagation 7/7 and integrated
checks 407/407 across 25 files, including a corrected projected-anchor index
proof and an early water/exclusion rejection control. Shared/server/client typechecks/builds and scoped
lint/format pass. Fresh native visual/performance qualification remains pending.
Keep root/tip shading fixed initially.
Color cannot fill coverage gaps; continuous canopy and smooth LOD remain open.

AMD's [procedural grass reference](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/)
separately addresses root darkening, normal softening and coverage compensation
through LOD. Those are useful design references, not native browser performance
evidence or permission to replace our grounded terrain with its planar patch.

Implementation has begun for an explicit fine-meadow profile: 25m grass-owned
cells borrowing real terrain, .7m spacing, slender .38–.86m independent stems,
and a 40m near-detail trial. Preserve the original native reference and all
authoritative exclusions. Corresponding blade roots/tips are progressive across
tiers, but full moving transitions, coverage and rendering cost are unqualified.
See `asset-studio/fine-meadow01/QUALIFICATION.md` for tests and remaining gates.

The first native fine capture exposed a camera-order bug before matched imagery:
grass detail followed the earlier gameplay camera rather than the final primary
render camera. The correction now uses the existing render-preparation boundary,
with cached pose/frustum and one bounded update; native03 verifies this and the
subsequent stale-LOD-intent correction. Final source passes 361/361 tests across
24 files plus shared/server/client types and builds. Native03 next stops at an
incorrect capture expectation for Three's small-cell uniform-matrix layout;
native04 verifies the corrected exact device/shader contract. Eight actual images
still show too much gray exposed turf, so increase individual leaf overlap and
soften root/normal shading without adding blades or changing global lighting.
Native04 also exceeds the natural daylight window on its eighth camera; re-admit
natural daylight per camera without widening the capture phase assertions.
Acceptance requires continuous eligible meadow volume, slender tapered blades,
no visible cell grid/detail ring, flush roots at slopes/rocks/trunks, and cohesive
green without a dark cyan blanket or fluorescent tips. Wind, temporal shimmer,
LOD transitions and sustained performance require motion evidence.

Native05 captures all eleven views: revised leaf area and shading improve local
overlap/curvature/green, but root and independent review still reject full visual
acceptance. Next target is coherent foliage/ground light response at fixed
population, not another height/density increase. Measured GPU-pass-sum p95 is
28.64/28.25ms (campus/meadow), worse than the sparse historical observation;
performance is not accepted and no presented-FPS claim follows. The run stops
before motion on a cached reflection-pipeline observer assumption. Native06
qualifies exact main/reflection bindings, then hits the habitat checkpoint's
16MiB serialization cap. Native07 verifies bounded lossless checkpoint transport
and saves both wind and moving-camera videos. Fixed-camera owner/source/root
invariance passes; the rail stops on a strict timestamp-uniqueness assumption.
The retained samples show 18→75→18m travel, LOD0→1→0 and no missing monitored
cell, but final revisited source/root/bounds collection was not reached. Both
videos are nighttime, so they do not qualify daytime softness, shimmer or subtle
LOD popping. Focused daylight native02 now supplies both clips and the missing
revisited source/root/bounds/draw proof; its final reporting failure is separate.
Keep native07's failure unchanged. Visual transition quality remains open.

The fixed-geometry height-dependent normal experiment is now tested and rejected;
keep the .20 constant, expanded regression coverage and captured comparison.
Indirect-only root occlusion remains a separate possible experiment, not a
proven normal bug, physical self-occlusion or a remedy for coverage holes.
The next explicitly disclosed color trial must preserve positions, draw passes,
textures, wind bounds and authoritative terrain/resource/service exclusions.

Native07 CPU p95 is 14.9/15.1ms and queried GPU-pass-sum p95 20.58/19.92ms for
campus/meadow; 55/58 actual main grass draws submit 2.10/2.65 million triangles.
Unchanged-source runs vary materially, so neither the faster observation nor
recorded-frame counts prove causal speedup or sustained/presented FPS. Rendering
headroom remains open without density or resolution cuts. The scoped source
checkpoint is committed/pushed as `8531b4cbf` under `dreaminglucid`; it remains
an explicit opt-in development candidate, not default or production promotion.

The user's earlier-game grass image supersedes provisional acceptance of the
current sparse tuft appearance. Saved reference and diagnosis:
`asset-studio/haven-architecture01/GRASS_RECOVERY.md`. Exact image provenance
is unknown. Root and independent review agree that fine overlapping blades and
continuous meadow volume are visibly stronger than the current isolated dark
rosettes. Retain those qualities at a lower height.

The earlier sparse island candidate used 1.75m clump spacing and twelve blades, while
ordinary near-grass uses .7m and twenty-four: 12.5× lower potential blade density
before eligibility/grounding/quotas, not a measured ratio to the screenshot.
Wider blades and three compact root patches cannot compensate for those gaps.
After architecture qualification, prioritize an explicit independently rooted,
slender, sufficiently overlapping meadow candidate before coastal work. Inspect
actual quotas and near/far LOD, preserve full-root grounding, access, wind and
quality settings, and measure added main/shadow/GPU/memory/loading work. No
still-image reference or passing implementation test proves visual acceptance,
motion quality or affordable density.

## Haven architecture checkpoint — 2026-09-13, art/performance still open

Native03 passes the local study after224 source/integration tests and37 capture
preflight tests. Independent verification matches722 source pins,644 archives,
24 checkpoints and44 fog brackets; all11 world PNGs and original9 cameras verify.
Source/render/actual-PhysX agreement and ownership are qualified for this slice,
not full traversal or production. Root and second visual review accept roof
scale/base/framing as a bounded improvement; dark timber, gray-blue plaster,
regular masonry and detached-looking lintels still need art work. Front detail
clips the apex; three-quarter shows the full roof. Grass is rejected above.

CPU p95 is18.0/18.8ms campus/meadow; summed GPU-pass p95 is19.398656/20.64384ms,
worse observed tails than habitat-native03, without isolated causality. Same
architecture draw counts, +1,016 triangles per main/sun pass; no free-cost or
sustained-FPS claim. All owned services/browser close, page/GPU/cleanup errors0;
19 existing cow/dagger errors still fail the overall capture. Report SHA256
`7a303d211260a61d600ff6c35592a7b55cb919b589a413ded03593f5b5406073`;
independent verification `asset-studio/haven-architecture01/native03-verification.json`
SHA256 `1ed9cc7da5aed8b804da9325478c5e2204a3cf205568e268e3565902ad81d756`.

The shared settlement kit is a completed local implementation slice. Reference image and full
built-in generation prompt: `asset-studio/haven-architecture01/CONCEPT.md`.
It establishes material/construction/landscape direction, not implemented pixels
or performance. Do not adopt incidental props, lighthouse or changed footprints.
Actual code inspection found color-only building surfaces and a 3.57× physical
roof-course mismatch. Explicit Haven recipes add restrained facade and roof
geometry plus bounded normal/roughness/occlusion response with common roof scale.
Keep current doors/windows/steps, station access, mesh/material owners and roof
cutaway/shadow semantics. Exact pre-finish identities remain comparison fixtures.

Primary research: [Three material nodes](https://threejs.org/docs/pages/MeshStandardNodeMaterial.html)
provide authored roughness response, and [surface-gradient bump mapping](https://jcgt.org/published/0009/03/04/paper.pdf)
provides a principled way to transform small surface slopes without changing
mesh geometry. These do not create silhouette, cast contact shadows or free
shader work. Geometry and surface response must be checked together under the
actual native WebGPU lighting, including oblique/moving views. Keep new normal
detail filtered at subpixel scale, preserve all existing main/shadow population,
and measure cost. Whole-landscape, lighting/contact and performance remain open.

## Shared habitat and avatar propagation qualification — 2026-09-13

Native03 now passes the local study after 325 tests across 20 files, three package
typechecks/builds and 30 capture preflight tests. Nine main views show only a
subtle local substrate transition, not a major art-quality improvement. The
whole setting still needs the high-impact work below. No appearance default,
AAA or sustained-performance approval is implied. Actual compiled shared-field
and grass ownership checks pass; 11,419 clumps / 411,084 installed grass triangles and
historical placement/grounding data remain exact. No extra textures or passes.

Failed native01/02 remain preserved: order-sensitive geometric work charges
must be reported separately across runs, and a redundant live own undefined
placeholder disappears in JSON. Narrow, tested observer corrections retain all
geometry/source-ID/output and same-run assertions. Native03 has zero page/GPU/
cleanup errors and closes owned browser/services; 19 existing content errors
still fail the overall report. CPU p95 is 17.9/14.8ms and GPU-pass-sum p95 is
18.81/19.07ms in the two short windows—not isolated savings or sustained 60fps.
The VP8 1280x720 wind clip decodes 232 frames and stops its recorder/tracks.
Report SHA256: `a842436948e9585ec865e7dfb190f6a7be710c567441062f0cc5b1be130038d0`.
See `asset-studio/habitat-propagation01/` for qualification evidence.

Independent final review matches all 717 source pins, 639 archives and 22
checkpoints. Root and a second reviewer accept a modest Haven substrate
refinement across nine image pairs, with no visible new hard seam/paint stripe.
Five avatar/shield pairs retain pose, color and placement; overlays prevent
full head/grip inspection. Three decoded wind frames show varying bends and
settled roots, not exhaustive motion acceptance. The opening encoded frame is
softer than later samples. Keep larger art, live physics, sustained frame and
streaming gates open. Verification JSON SHA256:
`fa64212bfb204b9e9e0b1a5ebfd90b2ccc8aab3e24eb71ec4c7b52971cb9f4b0`.

The current implementation adds an explicit `habitatComposition=haven-understory-v1`
trial on the existing natural-meadow route. Two authored, bounded convex pockets
connect the admitted foot-slope, functional tree bases and workshop rocks. The
same immutable half-plane field feeds complete terrain albedo/normal/roughness/AO
blending and the roots of existing grass. This is mineral-soil composition, not
new leaf litter. Grass tips, positions, grounding, all worker arrays, source IDs,
counts, bounds and shadow/resolution settings remain unchanged. It adds one
float varying to grass and no texture, geometry attribute or render pass. The
blade root uses the soil palette mean, not a claim of pixel-identical textured
terrain matching. Optional growth shortening is deliberately not implemented.

Real CPU/TSL and six-leaf worker regressions and native03's local study pass.
The verified native checks include actual terrain plus
six grass material owners, shared canonical field identity, compiled shader
evidence, exact historical signed-zero placement comparison and matched images.
No new appearance default is promoted by this local checkpoint.

The production avatar factory now propagates disjoint skeleton roots once,
preserving animation/recoil/humanoid order and existing movement behavior. The
authored 52-bone rig measures 457 to 61 recursive hierarchy visits per pass;
actual factory, seven animation clips and real VRM humanoid tests preserve bone
matrices, palettes, sampled deformation and attachments. This is reduced work,
not measured frame-rate gain. Native animated appearance/performance remains
open, as do the external CPU8 adapter allocation and equipment-LOD tasks.

Current upstream research reinforces measuring actual passes and bandwidth:
[Three's WebGPU post-processing guide](https://threejs.org/manual/en/webgpu-postprocessing.html)
documents combined passes and explicit MRT precision/packing, while
[Chrome's timestamp-query documentation](https://developer.chrome.com/blog/new-in-webgpu-121)
describes optional GPU pass timing and timer quantization. These capabilities
support controlled contact/lighting/temporal candidates; they do not establish
free performance or an AAA ceiling. Keep current native resolution, shadows,
population and matched reference views explicit in every comparison.

### Next high-impact delivery order

1. Finish the Haven workshop/bank → shoulder → pond-bank setting as a whole:
   stronger architectural bases/eaves, irregular stone boundaries, readable
   mineral faces and grounded shoreline transitions. Reuse the actual rock
   library and shared kit ownership, and improve silhouettes visible from the
   existing campus/Haven/pond cameras. Soil pockets cannot substitute for this.
   Preserve harvesting, stations, fishing and navigation; report every added
   main/shadow submission and memory cost. [Instancing](https://threejs.org/docs/pages/InstancedMesh.html)
   reduces submissions, not geometry/shadow cost.
2. Establish deformation-safe equipment LOD and measured frame headroom before
   accepting new fullscreen work. Current two-actor torso/leg kits alone submit
   about 1.145M triangles across main and sun. Retain close-up hero geometry,
   all required attachments and exact approved rest/weight ownership.
3. Qualify source-aware thin-leaf transmission independently of bark. The
   compact PBR branch currently bypasses the legacy backscatter term; a bounded
   [MeshSSSNodeMaterial](https://threejs.org/docs/pages/MeshSSSNodeMaterial.html)
   direct-light candidate may improve backlit leaf volume without adding ambient
   fill or globally recoloring authored teal trees. Retain alpha masks, wind,
   shadows and source identity. Reject glowing night crowns or washed-out bark.
4. Trial native contact occlusion separately, through
   [GTAO and builtinAOContext](https://threejs.org/docs/pages/GTAONode.html), not
   a dark overlay or the existing generic preference (which includes depth
   blur). Proposed initial comparison: 16 samples, 0.5/0.9m radii, unchanged
   native pixels and 4x MSAA. The depth/normal prepass, AO and possible denoise
   have real cost. Check animated/discarded vegetation, thin-surface halos,
   water/sky edges and moving cameras. Existing calibrated day-cycled PMREM
   already supplies environment lighting; do not double-fill it with ambient.

SSGI/TRAA remain later, explicit pipeline experiments. TRAA replaces MSAA and
requires correct velocity/history for animated foliage, avatars and camera cuts;
it is not a free quality toggle. A small habitat improvement does not close any
of these broader art or sustained-performance gates.

## Natural tuft trial and rendering research — 2026-09-13

The explicit `grassAppearance=natural-tuft-v1` trial uses the existing dense
meadow profile and 12-blade/36-triangle visible clump. Native01's broad paper-fan
silhouette was rejected. The revised three four-blade tufts use narrower
quadratic ribbons and an asymmetric shared height/lean hierarchy. Ordinary,
fixed-arena and previous meadow appearances remain unchanged.
Candidate wind uses world-space clump positions; smooth normals follow wind and
distance flattening without a new attribute, texture or pass. This is not exact
normal reconstruction of the later left/right root-height warp.

The native03 source passes 230 tests across 12 files, three package
typechecks/builds and 25 native preflight checks. The actual six-leaf
terrain/worker/grounding test preserves input arrays and all five installed
attributes for common survivors. A changed blade footprint can change accepted
populations without changing density settings; the first broad trial's CPU
census is not the final native census.

Native03 retains 11,419 clumps / 411,084 installed grass triangles across four
exact snapshots and six actual shader/grounding-buffer owners. That is 94 more
clumps than historical native05's 11,325 (+0.830%), not unchanged total work.
All 712 source pins, 634 archives and 18 incremental checkpoint hashes verify.
The eight-second 1280x720 VP8 recording completes, decodes 234 frames, and stops
its owned track/recorder. Root and independent review provisionally accept the
revised tuft silhouette, not whole-landscape or continuous-motion quality.

The full native03 study remains FAILED: an existing mushroom placement guard
rejects upload-counter advances after the grass/video gates. All 64 placement
buffers across 16 owners have identical full-buffer hashes/layouts with version
+1; production finalization unconditionally marks populated chunks for upload,
which is a plausible source-backed explanation, not a recorded call trace.
One separately qualified hero index widening also occurs. Do not ignore these
counters, claim JS-buffer identity across snapshots, or call the full run clean.
Downstream mushroom/outcrop images are missing; screenshot completeness fails.
Owned browser/launcher/services close and four ports clear. Zero page/WebGPU
errors coexist with 19 existing content errors. Native01 (exit137, cause unknown)
and native02 (now-fixed capture metadata collision) also remain failed records.

Native03's raw instrumented timings independently recompute: campus CPU
p50/p95/p99 = 15.2/32.3/44.7 ms (519 measured frames; max104.3 ms), meadow =
12.8/18.4/23.7 ms (592 frames). GPU render-pass sums are respectively
16.32/19.53/21.04 and 16.25/20.97/23.59 ms. These are not presented FPS or causal
grass costs. Campus CPU tails remain a real qualification concern. Actual
WebGPU 1280x720, 4x MSAA, existing shadows and no post-processing were retained;
no sustained-performance or default-promotion approval is implied.

Evidence: `asset-studio/game-test-integration/grass-natural-tuft-native03/`.
Report SHA-256: `131fa33934f55424caa7236b7e71cf1fc3832bf822f0120d25109d5ad9503e15`.
Video SHA-256: `f93b4c092dd9097343b78c78e4b50a383a4f49ff6ac44b9464ebe51c9eb9c1e6`.

Final review subsequently catches a fragment-stage edge case: opposing valid
vertex normals can interpolate to zero at full distance fade. Guarding that
interpolated normal and testing actual fragment inputs brings the final suite
to **231/231 across 12 files**; three package typechecks/builds and 25 native
preflight checks pass. Native04's local study and complete screenshot/cleanup
checks pass, with six native grass pipelines, four stable 11,419-clump snapshots,
nine world views and the completed wind clip. Overall remains failed on the
same 19 content errors, not on shader or cleanup failures. All 712 source pins
stay unchanged; owned browser/launcher/services close and four ports clear.

Native04 CPU p50/p95/p99 is 15.7/22.6/34.5ms campus (558 frames) and
14.2/19.6/24.0ms meadow (584); GPU render-pass sums are 16.25/19.92/21.50 and
16.25/19.99/21.10ms. This does not establish a causal improvement over native03
or sustained 60fps. The final 8,015.9ms clip is VP8 1280x720, 6,156,061 bytes,
228 decoded frames, with recorder/tracks stopped. Final report SHA-256:
`8dbf8e588772641bbd5c2bfd954cb870d6b2aef94cf28716702311dd95e2eabd`;
video `40e1c92306860efc38e993af5857277a523c1f064f83846d840975d186684a51`.
See `asset-studio/natural-tuft01/QUALIFICATION.md` for final versus historical
test hashes, the explicit counter-admission correction and retained failures.

The saved native03 CPU profile also identifies a no-quality-reduction
optimization hypothesis: `createVRMFactory` recursively updates descendants for
each skeleton bone, and movement forces another full hierarchy update. Qualify
one correctly ordered propagation from minimal roots against exact bone/skinned
position/normal/attachment behavior, animation and camera modes, with measured
traversal counts. The external CPU8 torso fixture separately allocates matrix
clones and transient per-vertex arrays during real deformation; pool these only
with identical arithmetic and safety guards. It is not a Chrome probe wrapper
or evidence of shipped-equipment performance. The profile has an initial1.193s
gap and late10-80ms sample gaps, so neither aggregate sampled weights nor GC
samples prove a cause for individual slow frames. Keep actual native measurement
and provenance, rather than declaring a speedup from source inspection.

### Next visible slice: connected habitat, not another blade adjustment

The terrain still reads as uniform turf with separate rocks and scattered
plants. Connect the admitted Haven foot-slope, western preparation trees at
(318.5,312.5)/(318.5,344.5), and workshop rocks into one coherent ecological
transition, first bounded to approximately x300-332/z303-365. Use asymmetric,
soft-edged pockets rather than circular tree rings or another talus stripe.
The existing grass/dirt/rock layers support mineral-soil transitions, not an
invented leaf-litter material. Share the composition across whole-PBR terrain
and vegetation, preserve functional tree positions and harvest/service access,
and measure any new cost. Historical resource IDs are not coordinates.

Current `havenGroundWeights` is color-only and `grassSupport` ignores Haven
wear/talus/planting, while the worker adds unrelated patch noise. That is the
implementation disconnect to address. Inline probability changes would also
re-phase the legacy RNG: genuine fixed-budget redistribution requires an
explicit bounded alternative pool, baseline quota and quota admission AFTER
full root grounding. Fail an unfillable candidate instead of silently thinning.
Require CPU/worker/TSL parity, actual installed counts/contact/routes, matched
close and aerial views, a moving path and measured native costs before approval.

The first implementation slice can avoid redistribution entirely: evaluate two
bounded habitat pockets in the terrain whole-PBR blend and at each existing
grass clump's world-space base. Blend the blade root toward the matching soil
mean while retaining its tip colour; optionally author local vertical growth
in [0.85,1]. Multiply the current distance fade by that factor in BOTH position
and smooth-normal graphs, never change uniform instance scale or post-grounded
world Y. The existing full-root validator sweeps fade 0 and 1, so intermediate
vertical factors remain inside its admitted envelope. Prove all five instance
arrays, source IDs, roots, counts and bounds unchanged. This creates coherent
substrate/shorter growth, not increased density or genuine leaf litter.

[AMD's procedural grass research](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/)
supports using curved ribbons and their derivatives to form readable grass
patches. We use those geometric principles within the existing instanced WebGPU
vertex path, not the article's different mesh-shader backend.
[NVIDIA's deformation chapter](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-42-deformers)
informs the normal correction; independent tangent calculations must verify the
actual shader graph rather than merely testing a second copy of its formula.

Three r186 already exposes local occlusion, screen-space indirect light and
temporal antialiasing. Those are subsequent controlled candidates, not free
quality switches: [SSGI](https://threejs.org/docs/pages/SSGINode.html) has explicit
per-pixel sampling and denoising costs; its temporal path warns about ghosting.
[TRAA](https://threejs.org/docs/pages/TRAANode.html) needs depth/velocity and
disables MSAA. Any experiment must declare that pipeline change, retain the
current native-resolution/MSAA comparison and test animated foliage, avatars,
camera cuts, contact and actual frame cost. Do not equate feature availability
with target-hardware performance or compensate through hidden quality cuts.

## Previous checkpoint: packed imports and mushroom LOD — 2026-09-13

The following plan is retained as history. The natural-tuft trial above now
implements the tuft and world-space wind work; the previous appearance remains
available unchanged, and broader landscape/performance gates remain open.

The packed-static import correction and same-owner mushroom LOD pass native05's
local study, not an AAA sign-off. The second native run exposed stale-camera
vegetation culling. The production correction now reconciles the final camera's
world transform, projection and depth convention without forced visibility or
changed draw distance. Final regression: 400/400 across 12 files, including 12
new actual quadtree/camera integration cases and 360 real sun rotations; three
package typechecks/builds and 30 native preflight checks pass. Native05 has five
close/transition captures and an identical-camera hero/LOD pair at 8.1m; both
reviewers accept local shape/color consistency. Independent checks verify all
710 pins/632 archives, actual main/sun draws and 25 rejected corruptions. Game
source `2f6f576ce05da4c2d1723ee1b40d349456446b1d` and assets
`a19894750710f2d8a7facdd98685011bf4c0ade5` are pushed under `dreaminglucid`.
Continuous temporal/contact quality and sustained performance remain open.

Do not infer a controlled speedup from previous mushroom totals: native02 and
the earlier Haven run submitted different instance/owner sets despite identical
recorded main camera poses. The earlier frozen view did not consistently govern
vegetation culling. Retain the failed receipts and establish a new final-camera
baseline. The 70.078% reduction describes one admitted model's triangle count,
not scene-wide frame time.

The next substantial visual change is **ground-cover cohesion**, not a denser
population or another broad exposure adjustment. Current `compact-meadow-v2`
already has curved geometry; its visible tier uses 12 blades/36 triangles per
clump, a 0.7m footprint radius and 1.75m center spacing. Reauthor that same budget
into tighter natural tufts with broader, shorter silhouettes and better root,
ground and blade-normal continuity. Keep existing instance counts, opaque
material, shadows, functional resource trees and the full rooting envelope.
Test changes as an explicit profile before accepting a new default.

Then address world-continuous wind: the current shader's phase uses chunk-local
offsets despite its world-space description. Equivalent world positions encoded
under different chunk origins must have identical phase. Preserve swept bounds,
anchored roots and displacement amplitude; verify changing normals and motion
in actual clips. Follow with shared mid-scale turf/blade reflectance variation,
restrained shrub color and deliberate coast/rock planting composition.

Acceptance requires low-angle, front/backlit and close moving-camera views,
complete grounding/worker/TSL parity checks, stable source and instance owners,
and actual workload/timing measurements. Static screenshots cannot establish
wind continuity, temporal stability or sustained frame rate. The current wide
views still look artificial; functional magic-tree colors are partly authored
and do not justify globally recoloring all trees or lighting.

## Ground refinement and useful frame headroom — 2026-09-13

The first Haven ground trial removes the arbitrary lawn color islands and
connects the workshop apron. Its broad gray talus band is visually rejected;
native02 retains a narrower slope-gated rock transition after two independent
nine-image reviews confirm the artificial band is gone. All1,330 regressions,
three package builds/typechecks and20 preflight tests pass;701 current source
pins/623 archives, unchanged terrain/grass hashes and48 resource trees are
independently verified. The19 existing content errors and sustained-performance
gate remain open. Do not present this local improvement as the finished landscape.

The latest source/receipt audit identifies a concrete scalability defect: small
mushrooms have 5,013 triangles each, no supplied LOD models, and category-level
LOD/impostor exclusions. They submit 270–391k triangles across main and sun in
the two recorded views. Complete torso/leg kits contribute about1.145M across
both passes for two actors. Trees are not the dominant geometry cost, and the
most visibly blue tree has intentionally teal/blue authored source maps.

Next performance work should retain close-up assets and actual populations,
but qualify geometry by projected visual error. Meshoptimizer documents
[attribute-aware simplification and screen-space error](https://github.com/zeux/meshoptimizer#simplification)
for preserving texture/normal quality and selecting suitable detail levels.
[Three LOD](https://threejs.org/docs/pages/LOD.html) provides distance switching
and hysteresis; our existing instanced vegetation owner should retain batching
and gain an explicitly admitted LOD path, not a separate per-instance object tree.
These mechanisms do not establish visual equivalence or savings by themselves.
Require close silhouettes, UV/normal response, threshold motion, zoom/camera
cuts, shadow continuity, loading/lifetime checks and actual pass/frame evidence.

## Shared Haven candidate implemented — 2026-09-13

The prototype below is now implemented in the shared profile/worker path and
selected in the local launch-branch manifest. Actual retained geometry rejected
the original 64-grid shape: 0.736m height discrepancy and 0.141m edge mismatch.
After forty bounded comparisons, the candidate uses wider drainage, an 8m face
and one local 64→128 leaf refinement: +24,832 triangles / 1,000,448 bytes, no new
terrain nodes/draws. Sampled discrepancy is 0.07574/0.07210m and the equal-grid
edge agrees to numerical roundoff. This supersedes the prototype's claim that
the unchanged mesh allocation suffices; native frame and visual gates remain.

Forty unit, four actual worker/mesh/road integration and two native PhysX/resource
tests pass. The latter cook test-owned colliders, not the live terrain owners.
Final regression is 1,324/1,324; shared/client/server typechecks/builds and lint
pass. Native01 includes a new eye-height Haven view plus eight exact comparison
cameras: 700 unchanged pins/622 archives, 37 fog brackets, 48 resource trees,
both actual 128-grid leaves and clean owned-session shutdown independently
verified. Overall run remains false with 19 existing dagger-fit/cow404 errors.
Short p95 CPU14/13ms and GPU-pass sums17.63/18.55ms are not presented FPS,
sustained60 or a causal cost comparison.

All nine images were visually reviewed. Local relief is improved, but arbitrary
yellow/green lawn patches, weak mineral/turf transitions, dark blue-green foliage,
inconsistent asset styles and the exposed coast still fail the art bar. The
next visual slice replaces noise-authored lawn islands with composed Haven
ground-cover, wear and talus using the current packed layers. No new full-screen
pass, light, resolution reduction or global quality downgrade is justified.

Source tracing additionally confirmed a terrain/camera PhysX query-mask bug and
an absent optional avatar foot-clamp implementation. Both now have explicit
launch tasks. See `haven-shoulder-terrain-20260913.md` and the mirrored checklist.
The native preparation broadcast has physics=false; these captures do not prove
averaged terrain boxes displaced the camera.

## Ready external terrain prototype — 2026-09-12

The bounded Haven west-shoulder prototype now uses one asymmetric ruled crest,
rock face, shelf and toe with an oblique drainage notch, not additional ellipse
hills or noise. Region X272–314/Z303–367; existing campus/arena grades retain
authority. 101,096 protected probes have exact zero delta; all48 archived native
tree heights reproduce, all11 paths/260 segments remain unchanged, and the same
two64/128 terrain leaves cover the change. The game has not adopted it yet.

Do not mistake this external analytical proof for a native surface. New slopes
exceed40 degrees at6,118/43,433 fine samples, versus363 before. Floor clamp and
nearest-polyline notch can make internal derivative creases; actual terrain mesh
spacing is1.5873/.7874m, not the .25m evaluation grid. Next: integrate into the
shared profile/worker path, retain protected surfaces, then check real triangle
contact, fresh tree/nav ownership and moving eye-level/aerial appearance before
acceptance. See `asset-studio/service-planting-soil01/terrain-next-slice.md` and
`haven-shoulder-evaluation02.json` for exact curves, source pins and remaining gates.

The preceding lossless shield pass confirms72 fewer actual submissions across
main/sun without detail loss. It does not supply approved headroom: native03 p95
CPU14.5/16.9ms and GPU-pass sums17.50/21.30ms remain outside smooth-performance
acceptance. No new postprocessing or resolution/quality reduction is justified.
Outer-face captures also expose existing sideways shield carry; keep that fit
gate open independently of successful geometry/material preservation.

## Next substantial slice: composed Haven landscape — 2026-09-12

The service-soil native pass is technically verified but **not art or performance
approved**. The reused dirt layer reads as gray gravel-like halos under the
shrubs; fern silhouettes are dark and the clumps remain overly saturated and
repetitive. Do not confuse this local contact improvement with a finished scene.
All eight current views and the concept were reviewed together. The dominant
remaining deficit is composition, enclosure and landform scale, not a missing
bloom or ambient-occlusion switch.

The concept establishes a low broken rocky backdrop behind the workshop and a
connected shore/soil/path hierarchy. Current buildings and trees sit in a broad
flat mottled lawn. `CompactIslandLandform.ts` fades the terrace delta out at world
X274–280, leaving roughly 47m before the western service beds. Smooth ridge and
saddle envelopes read as isolated capped hills. Increasing their noise amplitude
or applying another global color field will not solve that structure.

Author one connected Haven ridge-to-pond rocky-meadow slice: an unequal crest,
two readable rock faces, a lower shelf and irregular foothill/toe approaching the
workshop. Protect actual station, path, pond-fishing and tree-harvest envelopes,
not a broad arbitrary empty strip. Material allocation must follow these forms:
mineral faces, earthy hollows/toes, turf on the flatter shelves. Reuse the vetted
rocks for human-scale edges, not mountain-sized props. Existing choppable trees
must form the island's tree population; no disconnected decorative forest.

Resolve the silhouette and layered depth in unchanged ground-level and aerial
cameras before adding small details. Start within the existing local terrain
detail allocation, six-map budget, LODs and renderer/shadow settings. Maintain
server/worker/native agreement, supported assets and all functional approaches.
The exposed bay coastline remains a subsequent distinct slice. The large
playable island is not a preservation requirement; the user's compact-only
direction supersedes earlier historical preservation notes.

Frame headroom currently fails: short instrumented p95 CPU18.3/20ms and GPU-pass
sums28.38/33.88ms for campus/meadow. These are not presented FPS or an isolated
soil-cost experiment. Native-qualify the prepared lossless shield batching
candidate (23→5 primitives; identical geometry/materials/fit) before spending
more frame budget. Also retain the build-contended grounding failure as a stress
follow-up; the unchanged-budget standalone suite passes1,278/1,278.

Evidence: `../asset-studio/service-planting-soil01/README.md` and
`../asset-studio/shield-material-batching01/README.md` from this repository root.

## Material and lighting follow-through — 2026-09-12

The native landscape-rock review confirms a render/contact/LOD checkpoint,
not finished art. All eight views still show weak material integration, blue
shadowed foliage, a flat lawn and artificial coastal/ridge shapes. Do not
mistake more props or green software tests for closing this visual gap.

The installed renderer is already Three r186. Current official references:

- [Standard node materials](https://threejs.org/docs/pages/MeshStandardNodeMaterial.html)
  use the scene environment for PBR lighting. The importer had unconditionally
  erased authored metalness under an obsolete no-environment assumption.
  The import and persisted-cache policy are now corrected; eight native daylight
  views verify actual service-model factors/maps. Night, broad asset appearance
  and integrated art/performance acceptance remain open.
- [MeshSSSNodeMaterial](https://threejs.org/docs/pages/MeshSSSNodeMaterial.html)
  provides an experimental direct-light scattering term. Its installed source
  cites the author's [real-time translucency work](https://colinbarrebrisebois.com/2011/03/07/gdc-2011-approximating-translucency-for-a-fast-cheap-and-convincing-subsurface-scattering-look/).
  Evaluate thin foliage only after inspecting source normals/materials. This
  is not full volumetric scattering or permission for unshadowed emissive leaves.
- [GTAO](https://threejs.org/docs/pages/GTAONode.html) can add contact occlusion;
  [SSGI](https://threejs.org/docs/pages/SSGINode.html) can approximate local
  indirect light. Both cost samples; temporal filtering adds motion-history
  risks. SSGI's documented temporal path requires TRAA and warns about ghosting.
  Qualify animated foliage, agents, camera cuts, water and cutaway roofs before
  selecting either. Do not add them merely to darken an incoherent material mix.

Working decision: fix imported material fidelity and qualify foliage light
response first, with no changed exposure, resolution, terrain, trees, population,
camera or shadow budget. Then revisit contact/local indirect lighting and the
larger authored landforms. This is an implementation sequence, not a claim that
these features alone deliver the requested quality.

## Current priority after native review — 2026-09-12

Curved instanced grass is pushed as an explicit comparison-profile checkpoint,
not finished environmental art. The subsequent two-scale ground-colour candidate
passed technical checks but was rejected after eight native views: adding fine
mottling did not materially improve the scene. Its source changes are removed
and evidence retained in `compact-grass-grounding-integration01/field01/` under
the local asset studio. Do not repeat that generic colour-noise route.

Deliver the existing preparation-scene target as an integrated art slice:

1. Deliberately compose grounded rock and understory groups around pond banks,
   grove edges and the workshop approach. Use the existing scanned outcrop LOD
   library where suitable, but provide physical obstruction/navigation where
   visible rocks occupy playable space; the temporary six-rock diagnostic is
   not permanent world placement. Keep trees as actual choppable resources.
2. Replace the scattered-stations-on-a-lawn impression with worn interaction
   ground and a cohesive stone/timber architectural kit: bases, framing,
   eaves/ridge/end treatment and credible workshop detail. Preserve roof-cutaway
   camera behavior, fixed interaction access, authoritative collision and costs.
3. Review the pond → bank/workshop → arena route in motion, alongside close and
   broad stills. Require coherent silhouettes, scale, surface contact, foliage
   color and useful gameplay sightlines. Follow with sustained target-hardware
   and encoded-stream checks; existing short instrumented windows are not those
   acceptance gates. Large geology must use deliberate closed construction,
   not the rejected automatic open-facade closure approach.

The concept below remains a target, not a claim that the game looks like it.

User review, 2026-09-10: the current terrain is still lackluster and low quality.
This is accurate. Removing biome wedges and correcting sampled grass contact
did not turn the bare grass/dirt blockout into a finished game environment.

Current work and explicit source-test/cost limits are recorded in
`compact-pond-bank-checkpoint-20260910.md`. The material/path/local-detail
candidate is implemented; it is not yet an accepted finished environment.

## Visual target, not a game screenshot

The imagegen skill was used to establish a concrete environment-art reference
with the built-in image tool. The local project copy is
`../asset-studio/island-environment-art-v1/compact-preparation-target01.png`
relative to the game repository; the full prompt is in `TARGET01_PROMPT.md`
beside it. PNG SHA-256:
`53817adc8d258ccb6b21582a0a228b8a18ed57e1b184f55e997dee1599e70b50`.
These authoring files are local, not part of the game source push.

The reference demonstrates deliberate rock/bank silhouettes, a readable natural
pond, differentiated stone/earth/grass/wet margins, grouped vegetation and a
connected workshop-to-arena route. It is **concept art**, not implemented assets,
approved placement, measured performance, or a promise of identical rendering.
Its arena count, building placements, dense foliage and decorative items are
not authoritative game data. Preserve functional IDs and validate any relocation.

## Build one finished preparation scene first

The first real art slice is the existing pond → bank/workshop → arena approach,
not another generic noise or palette adjustment across the entire map.

- [ ] Author clear primary/secondary landforms: low rocky ridge and coherent
      coastal silhouette; believable local pond banks and shallow depth; usable
      paths, flat interaction areas and unobstructed combat-camera sightlines.
- [ ] Give the bank, furnace/anvil and cooking locations a shared architectural
      setting and worn ground. Use a small reusable stone/timber kit; avoid isolated
      stations sprinkled on a lawn. Keep authoritative interaction positions valid.
- [x] Integrate six packed soil/turf/rock maps with actual normal/roughness/AO,
      exact-byte preflight and decode controls. Follow-up adds anti-repeat grass/dirt
      projections and worn path edges; finished wet-bank transitions remain open.
- [ ] Compose bounded rock, shrub and grass clusters around banks/paths, with
      intentional open circulation. Preserve batching, shared materials and LODs;
      do not blindly turn on bulk procedural population or grass everywhere.
- [ ] Use the existing choppable resource trees as the island's tree population,
      naturally distributed around the compact one-arena layout. Preserve reachable
      resource targets, tier availability, collision, depletion/regrowth and agent
      preparation. Do not fill the landscape with a separate decorative forest.
- [x] Resolve ocean material ownership and visible square water transitions.
      Ocean appearance must not change simply because a chunk center crosses a mask.
- [x] Compare bounded denser pond geometry: two100m streaming leaves now use128
      vertices/axis; hub policy64, other streaming leaves16. Final irregular-pond
      RMS error0.02764650m, maximum0.17675727m over7,921sample points. The two actual
      leaves have66,548triangles/2,690,928geometry bytes, +49,664triangles/+2,000,896
      bytes versus64. These are explicit costs, not frame-time acceptance.
- [ ] Finish pond/coastal topology and all-footprint prop contact; the measured
      residual bank error and circular silhouette are not a finished terrain gate.
- [ ] Capture actual close, preparation-wide and arena-approach gameplay views in
      consistent daylight, then moving-camera and night views. Evaluate composition,
      scale, material response, contact, silhouette and UI/agent readability together.
- [ ] Measure representative loading, CPU/GPU frame distributions and memory with
      the real agents/assets/stream workload before accepting performance. An image
      reference or intrusive static diagnostic cannot satisfy this gate.

Acceptance is an actual recognizably finished scene, visibly beyond the current
blockout while retaining the working preparation/duel loop. Numerical correctness
and material startup tests remain safeguards, not the main art deliverable.
The full island, equipment, reliability and launch checklist remain open.

## Existing-kit starting point

Read-only local inventory identifies `rocks/med_rock_v2.glb` and
`rocks/big_rock_v2.glb` (778/910 triangles, one primitive each, embedded albedo/normal/ORM)
as a small starting boulder pair. Existing round/path stones, ferns, shrubs and
oak variants can supply selected clusters after visual/texture-budget review.
The local `terrain/textures/{stylized_grass,dirt_ground,rock}` folders contain
normal/roughness maps now used through the six losslessly packed terrain maps.

Do not enable the current generic vegetation path unchanged: it extracts only
the first mesh of an asset and its water-clearance policy excludes pond-bank
placements. Some low-triangle assets have large 2K textures; triangle counts alone
do not qualify them. An isolated Blender pond kit now contains boulder, flat
stone, fern, bush and original reeds. The promoted CC0 Fern02 brings the kit to
approximately21.9427MiB estimated texture/mip allocation and37,068submitted
main-pass triangles across32instances/five batches. Probe17 verifies improved
wet margins/root contact, not finished habitat or representative performance.
A reviewed workshop-canopy candidate still awaits collision, flue and camera
integration. Imported asset creator/license attribution remains unresolved; this
inventory is reuse research, not a distribution-rights or performance approval.

## Open island-layout dependency plan — 2026-09-20

All eight requirements below remain **OPEN**. This is implementation sequencing,
not evidence that any layout, navigation, interaction, art or performance gate is
complete. Author one deliberate compact-island layout first; do not accumulate
independent visual-only relocations that disagree with authoritative gameplay.
`packages/server/world/assets/manifests/world-areas.json` owns the current
station, NPC, resource, pond and water placements, while
`packages/server/world/assets/manifests/world-config.json` owns the admitted
compact-island overlays. Preserve existing station, resource, NPC and quest IDs
when their positions change.

- [ ] Place multiple banks across the island. First version the singular
      `compactBankPavilion` ownership and `CompactIslandPaths.ts` assumption of
      exactly one bank into explicit ID-addressed bank/pavilion/service records.
      Every bank must keep its clerk/service identity, reachable interaction
      point, pavilion geometry, collision, grass exclusion and path connection
      in one admitted descriptor; a second decorative bank is not sufficient.
- [ ] Author multiple named mine areas with distinct ore populations. Keep ore
      definitions and yields in `gathering/mining.json`, but place the canonical
      resource IDs in explicit mine bounds in `world-areas.json`. Prove each node
      is reachable, targetable, blocked where its visible mass requires it, and
      remains governed by normal depletion/regrowth authority.
- [ ] Distribute every intended choppable tree tier across the island, with
      higher tiers deliberately rarer. The current `compactResourceGroves`
      schema in `world-types.ts` and `CompactResourceGroves.ts` admits only the
      present restricted subtypes/regions, so version that contract before
      authoring the distribution. Keep tree resource identity, collision,
      reachability, depletion and regrowth; decorative substitutes do not count.
- [ ] Compose a small open-pavilion service town rather than enabling the legacy
      broad procedural-town path. Version the singular `compactServiceCourt` and
      `compactBankPavilion` config into a bounded plural court layout consumed by
      `CompactServiceCourtSystem.ts` and `CompactServiceCourtVisualsSystem.ts`.
      Derive visuals, physics, grass exclusions, navigation and readiness from
      those same descriptors. Keep procedural town population disabled through
      `townCount: 0`; retain the town system's manifest-service support.
- [ ] Move quest NPCs beside the skill areas they introduce. Placement belongs
      in `world-areas.json`; identity and quest linkage remain in `npcs.json` and
      `quests.json`. Preserve those IDs and validate dialogue, quest start/turn-in,
      nearby resource access and paths after each relocation.
- [ ] Scatter the rune altars as intentional island landmarks. Preserve the
      existing altar/station and rune-recipe identities from `stations.json`,
      `runes.json` and `recipes/runecrafting.json`; add explicit routes, usable
      interaction clearances, collision and grass exclusions for every altar.
- [ ] Replace the current circular pond silhouette with a deliberately natural
      authored shoreline. `RadialPondTerrainProfile.ts` and
      `CompactPondDressing.ts` currently derive terrain/contact dressing from one
      radial profile, so version the shape contract rather than disguising the
      circle with visual props. Terrain, water, wet-bank material, dressing,
      collision and grass grounding must consume the same admitted shape.
- [ ] Move that pond farther inland as part of the same pond change, not as an
      independent coordinate edit. Relocate its `world-areas.json` flat zone,
      water body, fishing spot and related NPC together; update
      `CompactIslandPaths.ts`, `RoadNetworkSystem.ts`, `TerrainSystem.ts`,
      `GrassTerrainSurfaceSnapshot.ts`, `GrassWorker.ts` and
      `GrassBladeGrounding.ts`, then prove shoreline clearance, water/terrain
      contact, fishing access and route reachability.

Implementation order is: version and fail-closed validate the plural/shape
schemas; author the complete placement graph once; materialize terrain, water,
resources, pavilions, physics, grass exclusions and roads from it; then run
deterministic ID, interaction, collision and reachability tests before native
traversal, art and performance review. Moving only meshes or markers is not an
acceptable shortcut: server movement, agent paths and interaction authority must
agree with the rendered world before any item can close.
