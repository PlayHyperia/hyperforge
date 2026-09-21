# World graphics development checkpoint — 2026-09-20

## Secondary pond bank, bank discovery and retained-ground alignment

The pond capacity requirement remains seven fishing families / twelve fish,
fourteen simultaneous anglers plus overflow, non-dock shore access at every
tier, and two visually distinct procedural docks. Keep LAYOUT-01–08 open.

Fixed a reproduced nearest-bank discovery bug in agent deposit-all: a bank
selected during the search no longer filters out later, nearer banks. Only an
explicit requested ID filters discovery. The real World/player/BankEntity/
inventory/PostgreSQL regression fails before and passes after; final 16/16
custody cases pass. It proves shared player balance across two physical bank
fixtures, withdrawal, exact-ID/range rejection and replay without a second debit.
It is not final-layout transport, concurrency or restart acceptance. Existing
agent-bank regressions pass 43/43. Legacy in-memory banking/event consumers
remain a single-authority audit gap.

The candidate fixture adds a second bank court at (384,438), chest (382,436),
clerk (386,440), informed by fifteen actual-owner site probes. Detached assets-v6
includes its registered clerk; v5's missing NPC catalogue entry is corrected
and its failed evidence retained. No live/default manifest is promoted.

The new station blend exposed a 27.541mm indexed-ground mismatch. Plural bank
courts now reuse existing bounded collar refinement around loaded station pads;
historical singular behavior, height rules, resolution and all caps stay intact.
The witness drops to 0.000575mm; 6,561 bank-envelope probes stay within
0.462349mm and 36 footing probes within 0.098293mm. The affected terrain leaf
adds 1,144 vertices / 2,288 triangles / 91,520 geometry bytes. These are sampled
geometry measurements, not sustained frame-performance approval.

Real route evidence remains FAILED. V6-04 completes fourteen same-start bank
comparisons: 457 total pond-bank ticks versus 1,473 town ticks. Two town returns
fail and their pond comparisons are skipped. Final v6-05 records 28 journeys,
24 complete and four failed town returns at the two known shore destinations;
only twelve comparisons complete. A one-bank v4 control reproduces the bounded
search failure too. Exact movement can stop after a 250-iteration partial search
despite an available destination. All seven non-dock witnesses pass, but this
is not complete 64-leg acceptance. A separate crowded relocation leaves an
angler enclosed by water and occupied cardinal tiles. Do not increase budgets,
allow illegal diagonal corner cuts, teleport or hide failures with later passes.

Native30 fails the original 30-second overview grass-transition gate.
Native31/32 capture the actual outpost at matched camera placement, unchanged
1280×720 Chrome/Metal quality. Arrival settling takes 11.78s / 9.56s respectively,
but native32 fails the original 90-second startup gate and is art-inspection
only. Both views are rejected for final art: excessive grass in the court,
missing worn arrival/connector and a repeated town-bank silhouette.
No AAA, sustained performance or streaming acceptance is claimed.

Final gates: canonical server 68 passed / two intentional candidate skips;
stock shared geometry/profile/water 78 passed / three candidate skips;
focused v6 retained surface 2/2; historical singular/shoulder/seam controls 3/3.
Shared typing covers 732 roots and server typing 3,954 program sources, zero
diagnostics and stable pins. Banking's focused type check also passes. Scoped
lint/formatting and independent review pass. Earlier fixture/import/hash errors
and incompatible whole-overlay attempts remain recorded, not counted as passes.

Build15/16 each emit eight isolated bundles from 973 stable production inputs.
All 145 protected artifacts remain intact. Private runtimes 16–19 and browsers
30–32 are closed, with owned ephemeral databases removed; human localhost and
its database remain untouched. No shader, density or quality-budget reduction.

Next: retain/resume bounded detour search; preserve crowd escape space and
coordinate yielding; compose the outpost arrival/planting/character; qualify
bank authority/transport and whole-layout routes, then startup and native art/
sustained performance. Do not promote the candidate before these gates pass.

Evidence: service-layout two-bank-custody-before02/after01/regression01/types02;
pond-outlying-bank-sites03; pond-secondary-bank-candidate-v6-04/05,
regression02/types02/format04/lint03; bank-collar-before01,
stock-regression02/v6-actual-final01/singular52-final01/types-final01/
eslint-final01; inland pond assets-v5/v6, build15/16, runtime16–19, native30–32.


## Ground-item boundaries, PostgreSQL custody and pond-bank journeys

Fixed a reproduced historical tile-snap boundary defect: a source requested
outside protection at z=348.49 could be planned at protected z=348.5. Single,
batch and direct-spawn paths now validate the final grounded position before
returning a durable plan or performing persistence/merge/presentation. The
actual compact protection geometry and all economic rules are unchanged.

Four new actual World/Terrain/EntityManager source-planning cases cover 36
facility-edge samples and the legacy snap witness; these plus 19 existing
regressions pass. The canonical shared gate passes 162 cases with four
intentional candidate-only skips. Shared source-aware typing passes 732 roots,
zero diagnostics. Independent review found no remaining production blocker.

The final real PostgreSQL run passes 15/15, joining actual grounded item/arrow
source plans to fully migrated custody transactions at dry pond and ordinary
grounds points. All three protected facilities reject source planning and
recoverable ammunition with no debit/receipt/source. Fresh owners/pools replay
exact quantities and coordinates without a second debit. The existing
safe-death outage/recovery case passes too, but it is not a new pond
death-handler, grave, socket, projectile-flight or caught-fish reward test.

The candidate route test instantiates real terrain, generated/authored
resources, all eleven manifest NPCs, stations, arena walls and native CPU
PhysX dock/court/rock owners. Both decks, seven family approaches and seven
verified non-dock approaches complete sixteen round trips / thirty-two legs;
every bank arrival passes actual station_bank_spawn physical authorization.
In the final candidate05 arrangement, legs take 39–64 logical ticks,
not wall-clock or FPS measurements. All sampled end-step static flags and
root support checks pass. The painted-width capsule avoids all protection
aprons exactly; 34,432 perimeter samples find no pond water.

Free movement crosses traversable lobby/hospital floors on 21/32 observed
legs. That is design evidence, not justification for invisible walls,
road-only movement or immunity exceptions. Only one bank exists in this
candidate; a composed secondary bank and shorter preparation journeys remain
LAYOUT-02 work. Bank transfers, simultaneous traffic, dynamic mobs, physical
stepping, rendered crowds and all randomized arrangements are not qualified.

Full candidate tests pass 20/20 through the checked-in server config's explicit
route mode (actual source/PhysX resolution, unchanged normal test mode).
Canonical server regressions pass 68 with two
intentional candidate skips. Server source typing covers 3,954 transitive
sources with zero diagnostics/stable pins; scoped lint/formatting pass.
Build14 emits eight isolated bundles from 973 stable production inputs and
preserves 145 protected artifacts. No default manifest, served build or
graphics-quality setting is promoted. Human localhost/database remain intact.

Evidence: service-layout shore-source-before02/after02/regression02/types02,
facility-custody-pg01–04, pond-bank-routes-candidate-v4-01–05,
pond-bank-routes-regression02/types01; inland pond isolated-build14-report.
Failed setup receipts remain. All temporary PostgreSQL containers are removed,
including a deliberate nonzero-child cleanup check. Keep LAYOUT-01–08 open.

## Facility protection and all-tier fishing capacity checkpoint

Implemented an opt-in `facility-floors-v1` protection contract: actual ring,
lobby and hospital floors plus their existing one-metre apron, not the broad
rectangle around them. Shared death/drop/ammunition/resource consumers use
this predicate. Client/server lobby challenges share actual lobby-floor
eligibility; queued callbacks recheck both participants. Zone membership,
overlap priority and cache edges now follow the three component rectangles.

Malformed metadata fails manifest admission before readiness, even with
SKIP_VALIDATION. Unmarked manifests retain their historical behavior. Only
detached assets-v4 opts in, with explicit ordinary safe grounds between the
facilities and lower-edge shoulders preserving historical boundary tile
centers. No live/default manifest, compiled human output or lighting default
was promoted. Assets-v3 remains the rejected exclusive-minimum-edge study.

The new actual-owner capacity test covers fourteen fishing resources, seven
families and twelve fish. All fourteen anglers plus seven additional arrivals
were admitted on distinct dry in-range shores. Real cancellation, entity
removal/re-entry and resource relocation end with 21 active sessions and no
pending gathers, reservations or movement intents. This proves observed CPU
admission/lifecycle, not durable rewards, socket reconnects, full collision,
bank journeys, native crowd quality or every randomized arrangement.

Final verification: 152/152 shared regressions; 68 server regressions with one
intentional candidate-only skip; candidate-v4 19/19 with zero skips. Shared
source typing covers 731 roots; server typing covers 3,953 transitive sources;
both have zero diagnostics and stable pins. Scoped lint/formatting pass.
The new cases use actual systems/filesystem loaders; existing mocked custody
suites are regression coverage, not real death/database transaction acceptance.
Early fixture/type/expected-zone failures remain recorded and corrected.
No timeout, pathfinding, render-quality or resource budget was increased.

Build13 emits eight isolated bundles from 973 stable inputs, preserving 145
protected compiled artifacts. Native29 verifies eight actual client zone/
protection/lobby samples, including both overlap and lower-edge cases. The
original 90-second startup gate passes, camera/grass settling is 11.008s within
30 seconds, and five HUD leases complete. Root inspected the captures: the
fine dock grid still appears at production shadow bias and disappears under
the temporary zero-bias control. Defaults, materials, camera and clock are
restored. Scheduler-disabled streaming-state 503s and the known cow-model 404
remain recorded; no full-runtime, streaming, performance or final-art approval.

Runtime15 and the owned browser are closed, its ephemeral database is removed,
and cleanup has no errors. Playable localhost:3333, its server/database and
compiled bundles remain unchanged. Independent source review found no
remaining checkpoint blocker. Keep LAYOUT-01–08 open; next qualify actual
custody/queued-challenge transactions and full-width bank routes, followed by
whole-scene shadow behavior and stronger bank/planting/dock art.

Evidence: service-layout-network01-UNQUALIFIED/arena-footprint-regression03,
arena-footprint-types02, arena-footprint-server-types01 and
fishing-capacity-candidate-v4-01; inland-pond-integration01-UNQUALIFIED/assets-v4,
isolated-build13-report, native29 and runtime15. Do not promote this candidate.

## Fishing approach, fitted dock supports and shadow attribution checkpoint

The seven-family / twelve-fish pond contract remains: fourteen simultaneous
anglers plus additional arrivals, every-tier shore access and two distinct,
characterful procedural docks. None of the layout acceptance gates is closed.

Fishing approach selection now enforces the authoritative four-metre radius
and uses four tile rings instead of ten. Rejected movement releases reservation
and arrival emote. An exhausted route may choose another valid shore without
resetting the original deadline or completion ID. Recovery requires a
movement-owned failure for that exact destination, with no active/deferred
route. Explicit stops and replacement intents clear stale failure evidence.
Independent review caught an intentional-stop restart regression and verified
the correction. No retry, pathfinding or timeout budget increased.

Final CPU gates: 68/68 canonical regressions, 18/18 real-owner tests against each
immutable baseline and candidate manifest set, 16/16 dock tests, shared typing
729 roots and server typing 3,954 transitive sources with zero diagnostics;
scoped lint/formatting pass. Three old mock-only fishing cases were superseded
by actual-owner coverage, including four-angler relocation, real obstruction
and BFS deferral, active/deferred stops, exact failure identity and cleanup.
These checks do not prove fourteen simultaneous catches, persistence,
transport, economic custody or long-run capacity.

Dock caps meet the actual plank underside and shafts meet the cap underside.
Counts, deck position/index prefixes and five legacy whole-buffer goldens
remain exact. Native PhysX retains 86 rays plus 16 support-site rays. The source
does not change shaders/materials, textures, seeds or collision top surfaces.
Build12 emits eight isolated bundles from 973 stable inputs and preserves all
145 protected compiled outputs.

Native24/26/27 isolated the fine dock grid to shadow reception/bias, not the
actual board variation or filtered grain. Native28 repeats the comparison on
the corrected geometry. Its original 90-second startup gate passes, landing
camera/grass settling is 10.209s within the unchanged 30-second gate, and all
five HUD leases complete. Root inspected the images: support-cap patches are
gone; the fine grid persists at +0.0002 sunlight bias and disappears under the
temporary zero-bias control. Shadow casting/reception remain enabled in that
control; production defaults are restored and unchanged. Qualify both docks,
contacts, terrain, vegetation, animated avatars, pavilion and arena surfaces at
multiple actual light angles before promoting a bias change. This is not
final-art, runtime-wide error-free, streaming or performance acceptance.

Native22/23/25 helper-selection/discovery failures remain recorded.
Native21's third HUD-root failure came from the intentionally scheduler-disabled
runtime's independent 120-second waiting-for-duel-data UI timeout. This does not
erase native19/20's actual 90-second grass-startup failures.

Evidence: inland-pond-integration01-UNQUALIFIED/native22–28, build12 report and
runtime13–14 cleanup; service-layout-network01-UNQUALIFIED/fishing-approach-
regression06, baseline05, candidate05, types06, dock-support-* and
pond-dock-cap-types01. Owned test browsers/runtime/database are closed;
playable localhost, its database and compiled bundles remain unchanged.
Keep all LAYOUT-01–08 gates open. Next: arena/custody footprint and all-tier
crowd access, then whole-scene shadow qualification and stronger bank/dock art.
Do not promote the unqualified pond manifests.

## Pond capacity, headland and timber checkpoint — candidate remains unqualified

The launch contract covers all seven fishing families / twelve fish, fourteen
simultaneous anglers (two per family) plus additional arrivals, every-tier shore
access and two distinct procedural docks. These are acceptance requirements,
not a claim that fourteen spawned resource entities prove usable capacity.

Read-only gameplay review found two independent blockers. The broad arena
rectangle contains ten of fourteen fishing targets, the supplier and landing;
seven complete four-metre interaction disks lie inside it. An explicit compact
facility protection footprint must be applied consistently to custody, drops,
ammunition, evacuation and lobby challenges without widening privileges or
removing ordinary safe-area custody. Validate full-width bank routes too.
Fishing approach search also lacks the authoritative four-metre reach filter,
ignores rejected movement admission, and does not prove fourteen distinct
usable approaches or relocation spacing. Existing mocked-shore / three-resource
soaks are not live basin capacity evidence. All remain unchecked launch work.

The isolated art candidate adds a southern turf headland, unequal coves and a
third ground-cover sector, retaining water center/datum/envelope and both dock
positions. Measured water area is 1,034.91m² (96.84% of the previous 1,068.73m²),
shoreline 117.72m, dimensions 41.97 × 34.47m. Actual admitted indexed terrain
passes 169,560 probes with maximum 1.099cm height and 3.097° facet-normal error,
finite/unit mesh normals and exact shared seams. Worst leaf uses 64,670/65,536
extra vertices: only 866 spare, not scalability approval. No cap was increased.

Compact timber uses stable dock/member/board identity and one shared local
growth field for side/end color and roughness. No textures, micro-normal,
material slots or geometry were added; physical top buffers remain exact.
The historical zero-mask path remains, but pixel equivalence is unproven.
Native review below does NOT approve the new timber appearance.

CPU verification: 15/15 dock cases; 91 canonical terrain/path/habitat passes
plus one intentional candidate-only skip; 7/7 actual-admission checks; 729-root
source typing with zero diagnostics; scoped lint/formatting. Water/fishing
records 26 passes and one failure: the historical test shrinks only the water
envelope to 12m while keeping the 27m basin. Its immutable old-candidate control
fails identically. Keep the containment guard and the failed receipts; do not
describe that full run as passing. Earlier fixture/type failures are retained.

Build11 emits eight isolated bundles from 973 production inputs; only the dock
source differs from build10. Assets-v2 contains three exclusive manifests; old
candidate assets remain unchanged. All 145 protected outputs retain hashes.
Native19 and native20 FAIL the original 90-second startup gate with 4 and 30
grass cells pending. Native20 records 30 running grounding jobs, no waiting/
failed jobs or LOD swaps. Changed shore cover can affect local work; no causal
regression is established. Timeouts, density, resolution and budgets are intact.

Native21 is a separately labelled art diagnostic. Its original 90-second startup
gate passes; the optional 60-second inspection allowance is unused. Camera/
grass transitions pass their original 30-second gates at 29.06s / 11.69s / 4.37s,
with fourteen actual fishing entities in every observation. Overall native21
still FAILS: third-view HUD root identity changes, and its PNG contains the
loading-timeout overlay, not usable jetty art. The first two HUD leases complete;
camera/clock restore, browser closes and source pins remain stable. A recorded
grounding slice reaches 42.1ms; this is not seamless/sustained performance proof.

Root inspected all PNGs. The overview's headland improves the outline, but the
bank collar, blank service pads and sparse habitat still look artificial. The
landing timber remains grid-like/crosshatched. Do not mark final art complete.
Actual submitted WGSL confirms the compact field is active; retained legacy
terms have zero final compact weight. Half-metre joints can explain broad bands,
not the finer second line family. Next isolate actual board variation, filtered
growth and constant PBR under the same geometry/camera/light; fragment-hash
precision amplification is only a hypothesis. The third PNG provides no jetty
art evidence. Request diagnostics attribute all 41 native21 HTTP503s
to /api/streaming/state, whose scheduler is intentionally disabled in this
private runtime. The known missing mob model stays within placeholder scope.

Evidence: inland-pond-integration01-UNQUALIFIED/native19–21, build11 report,
candidate-manifest-assets-v2 report and pond-water-envelope-baseline01;
service-layout-network01-UNQUALIFIED/pond-headland-*, dock-growth-* and
pond-dock-art-types02. Runtime12, its temporary database and owned browsers
are closed; human localhost/DB identity and bundles remain unchanged.
No final art, live concurrent fishing, route/custody, stream, smoothness or
launch approval. Keep every LAYOUT-01–08 gate open and do not promote assets-v2.

## Shared grounding budget checkpoint — three native pond views captured

The small scheduler change is verified, not a full performance or art pass.
A ready-empty result can now use the remainder of the manager's existing 2ms /
8,192-operation allowance for the next nearest running job. The continuation
accepts a finite absolute deadline capped by its own standalone limit. Every
handoff retains input/region/surface/LOD ownership checks; at most one nonempty
mesh is published. Failure, waiting and cancellation terminate that call.
No density, shader, terrain, shadow, resolution or timeout setting changed.

Four new real-owner regressions include an actual grass-free service footprint
and real worker output, not substituted empty arrays or fake clocks. Both
changed suites pass 139/139; generation/pacing suites add 50 passes. The opt-in
pond cost diagnostic is skipped by its normal environment gate. Source typing
passes 727 roots with zero diagnostics and stable pins; scoped ESLint/Prettier
pass. Isolated build10 emits 8 bundles from 973 inputs without changing 145 protected
outputs. All four production/test source hashes match the qualified inputs.

Native16 first establishes queue-isolated render evidence by leasing the full
world tick, keeping Three's animation loop and rejecting unrelated queue work.
Its five forced samples have identical draw receipts: 6 passes, 427 reported calls,
3,390,305 triangles. Median GPU envelope 65.405ms and submit-to-idle wall 74.3ms
are diagnostic only: partial-transition population, overlapping pass intervals,
driver/IPC/scheduling and one 140.05ms GPU-envelope outlier. Its failed transition
was stamped after two initial animation frames; do not call it exact cut-to-ready
acceptance. Native17 restores the original cut timestamp and still fails.

Native17's complete observed ledger proves 34 empty completions each stopped a
frame with work remaining, despite 11.8ms total slice time. Native18 verifies the
new shared-budget handoff in real Chrome/Metal: 1,278 manager calls / 1,161 advances,
125 ready retirements (71 empty / 54 published), zero remaining jobs, and eight
multi-slice calls (maximum 13 continuations). Each grouped call retains one shared
absolute deadline and correctly debits its actual operation count; no call
exceeds 8,192 operations or one nonempty publication. No ledger overflows,
observation errors or owner changes; every hook is restored.

Native18 passes all three original 30-second transition gates: overview 28.02s,
landing 11.29s and jetty 3.89s. This is one observed run, not a causal benchmark or
sustained smoothness proof. All eight multi-slice calls measured at most 2ms;
the largest 38.6ms manager call was one continuation, not a handoff. Cooperative
checks cannot preempt allocations/GC or scheduling pauses; diagnose the actual
stall owner before claiming its cause or a hard 2ms wall-time guarantee.

All three native views have 14 actual fishing entities, two of each family, and
restored HUD/camera/clock controls. Root inspected all three PNGs. The pond still
reads too oval with uniform banks; timber reads repetitive/crosshatched; the
surrounding service pads and sparse habitat do not meet final world composition.
The retained console has 41 generic HTTP503 errors without request URLs and five
known missing-model 404/load errors. No runtime-wide error-free claim; attribute
the HTTP503 requests before accepting integrated health. Keep the existing
temporary mob placeholder scope; do not divert this work into a new cow asset.
No art, 14-concurrent-fishing, dock-route/custody, full-stream or sustained-FPS
approval. Keep all LAYOUT-01–08 gates open and do not promote this candidate.

Evidence: `inland-pond-integration01-UNQUALIFIED/native16–18/`,
`isolated-build10-report.json`; CPU receipts in
`service-layout-network01-UNQUALIFIED/grass-empty-handoff-*`.
Owned browsers, runtime10, runtime11 and ephemeral databases are closed, with
human client/server/DB identity and 145 protected hashes unchanged. Runtime09's
failed startup never produced a valid baseline receipt; retain its recovery
note and do not count it as a successful runtime. No dependency install,
human bundle overwrite, merge, deployment or real-value action occurred.

## Static avatar texture checkpoint — exact pixels, lower native allocation

The source now conservatively shares a source material's base/emissive texture
only for parsed static PBR VRMs with the same actual ImageBitmap and complete
matching texture state. Unknown metadata, animations/expressions, actual
texture-transform payloads, custom material callbacks and unequal UV/upload/
sampling state preserve the existing separate views. No cross-asset pool,
texture resizing, mip reduction, quality-setting change or asset rewrite was
introduced. Material instances remain independent; borrowed textures/images
are not disposed by the sharing decision.

Review caught a new coupling before acceptance: source setup callbacks can
change only the emissive transform. Sharing now occurs after every callback,
including repeat visits to a shared material, and checks new custom render/
compile hooks. The actual browser regressions verify those cases. Initial
native fixtures also correctly failed production eligibility: the installed
VRM loader injects an optional KHR_texture_transform declaration even without
a payload. Only that optional declaration is admitted; required declarations
and every actual nested transform payload remain rejected. Failed fixture01–03
receipts are retained. Their first preview sheets also had an evidence-only
row flip, corrected for WebGPU readback in fixture03 onward.

Final source gates: 53/53 real-class tests across material, bone-transform and
loader recovery suites; 726-root source typing with zero diagnostics and
stable inputs; scoped zero-warning ESLint and Prettier. Build09 emits eight
isolated bundles from 973 source inputs; all 145 protected compiled artifacts
retain their hashes. Intermediate build07/08 are retained but not the final
qualified source revision. No project dependency installation was run.

Chrome/Apple Metal fixture04 loads actual banker.vrm through the production
loader/plugin with its real ImageBitmap cache policy. Day/night and shadow/
unshadowed pixels are exactly equal before/after; 2,299 changed pixels witness
real shadowing, 69,946 witness lighting response and 16,514 witness the avatar.
The two 2048², twelve-mip sRGB native color allocations become one:
44,739,240→22,369,620 payload bytes. The actual factory creates independent
sibling materials; removal/material disposal of one sibling leaves the other's
pixels and borrowed native texture intact. Ten browser rejection/order cases
pass, with zero GPU validation errors and restored/disposed fixture resources.
The root agent inspected the correctly oriented contact sheet. This is texture
correctness, not approval of the temporary NPC art or character animation.

Native15's integrated pond census uses the original profile, 1280×720/DPR1,
camera poses and 30-second transition gate, with no calibration/timing hooks.
It records 310 creations/two destroys versus native14's 325/two. Known live
payload falls from 2,146,732,526 to 1,811,188,226 bytes: 335,544,300 bytes
(about 320 MiB). Independent comparison matches all 15 NPC/mob texture groups
and 35 character instances: both color slots remain, each old pair becomes
one native allocation, and all 30 recorded texture-state fields match.
Non-character live native allocation descriptor multisets match exactly.
ImageBitmap IDs are run-local, not cross-run pixel hashes. Six native depth
footprints remain unknown and bounded owner/node attribution still overflows;
do not describe the payload as physical GPU residency or a complete heap census.

The full native15 run still FAILS the unchanged grass camera-transition gate.
Its final settling observation has four grounding jobs and one LOD swap.
The retained failure screenshot shows the loading overlay, not an approved
pond view. No FPS recovery, final pond art, public stream, fourteen-concurrent-
angler gameplay, route/custody, or sustained-performance acceptance is claimed.
All layout and world-art gates remain open.

The mirrored pond contract now explicitly requires fourteen simultaneous
anglers (two per family), actual tool/consumable/reward/relocation handling,
and additional-arrival behavior without blocked through-routes. Two distinct
procedural docks, every-tier shore access, inland placement and natural world
composition remain required and unapproved.

Evidence: local `inland-pond-integration01-UNQUALIFIED/avatar-texture-native04/`,
`native15/`, `avatar-texture-census-comparison.json` and
`isolated-build09-report.json`; final CPU receipts are
`service-layout-network01-UNQUALIFIED/avatar-texture-{tests,types,lint,format}03`.
All owned Chrome/HTTP sessions and runtime07/08 are closed; both disposable
databases were removed. The human localhost client/server/database and all
protected output hashes remain unchanged. No human bundle promotion, merge,
deployment or real-value action was performed.


## Native allocation checkpoint — measured duplication, no quality reduction

This diagnostic-only slice changes no production code, assets, resolution,
grass density, terrain accuracy, shadow quality or acceptance deadline.
The seven fishing families, 12 fish, two positions per family, two distinct
docks and non-dock access remain the pond's open acceptance contract.

Native12 proves that two pond depth captures use different native destination
textures with a depth-writing back-side draw between them. A shared capture
cannot be assumed equivalent at grazing or underwater views.

Native13 records 29 frames with independent query pairs for each actual
initial/resumed render pass, zero GPU errors and 87 created/destroyed diagnostic
resources. Its unchanged 30-second transition still fails. The roughly 93ms
median timestamp envelope spans overlapping work, not exclusive pass costs
or steady-state FPS. Dawn's Metal implementation samples vertex start and
fragment end; these boundaries do not serialize intervening stages. See
[Dawn's Metal source](https://raw.githubusercontent.com/google/dawn/main/src/dawn/native/metal/CommandBufferMTL.mm)
and [Apple's counter profiler](https://developer.apple.com/documentation/xcode/analyzing-apple-gpu-performance-using-counter-statistics).
Do not sum the captured intervals to assign shader costs.

The census attaches before renderer texture creation and observes 325 native
allocations, two explicit logical destroys, 323 remaining textures and no native
counter overflow. Supported formats total 2,146,732,526 live texel/block bytes;
six depth-format footprints are intentionally unknown. These are not physical
resident bytes, allocator padding, canvas presentation or GC accounting.
The 321-texture Three estimate remains 2,194,944,230 bytes. Owner/node traversal
hits explicit bounds, so attribution is partial even though allocation capture
has no observed omission and no untracked Three native references.

Seventy-seven 2048-square RGBA8 full-mip allocations account for 1,722,460,740
bytes. Native14 traces 30 of those to 15 NPC/mob map/emissive pairs. Each pair
shares the exact ImageBitmap object and matching captured sampling, UV and
upload state, yet holds separate Three/native textures. The narrow opportunity
is approximately 320 MiB without changing pixels—not all 640 MiB occupied by
those pairs. Sixteen hashed large DataTexture CPU views are distinct. No
ImageBitmap canvas conversion or GPU pixel readback was used in this census.

The independent file audit reads only candidate-manifest references: 18 VRMs,
17 present, the already-known cow asset absent. All 17 present files contain
equal embedded base/emissive PNG bytes, equal sampler settings and UV0 with no
texture transform. There are 17 different hashes across assets. No declared
expressions, UV-animation factors, texture-transform bindings or glTF animation
channels appear in those files. The audit artifact SHA-256 is
`8ad20b27205fd6273f12663873d86fca04b4d43f2e38fd84d5a893e10a0d7e18`.

Next implementation: verify static-texture eligibility at the parsed GLB/VRM
factory boundary, then reuse only a source material's exact matching immutable
base/emissive texture. Default to no sharing for unknown/dynamic metadata or
different full state; retain independent per-instance materials. Do not pool
across assets, change color interpretation, dispose borrowed textures, or close
the shared ImageBitmap. Require real parsed-file and clone/lifetime tests plus
native same-pose pixels and allocation counts. This is not implemented yet.

Native14's five-frame queue-drained calibration rejects 50 writes outside
graphics.render before sampling any frame; no isolated GPU cost is claimed.
Source inspection points to the per-world-tick grass frustum upload, but the
capture has no buffer label and does not prove that owner. Future isolation
must own the complete world-tick producer and retain queue guards, with no
silently altered simulation clocks or resumed-gameplay claim.

Evidence: local `inland-pond-integration01-UNQUALIFIED/native12–14/`, including
the retained native14 runner/helper sources, texture census/fingerprints and
`avatar-image-audit.json`. All browser hooks, camera/clock leases and owned
browsers restore/close. Runtime06 is stopped through its owning parent and its
disposable database is removed; human localhost and protected outputs remain
unchanged. All layout/art/concurrent-fishing/performance gates remain open.

## Grass storage checkpoint — verified rendering, unresolved pond performance

The production change is limited to the two GrassVisualManager constructors.
It uses the existing versioned storage helper on each private cloned geometry;
identity matrices, population, dirty versions, transforms, geometry, grounding,
wind, culling and retirement logic are unchanged.

Four complete real-class suites pass 112/112 tests: GrassVisualManagerCells,
GrassVisualManagerGeneration, GrassVisualManagerPacing and GrassGroundingGpu.
Scoped lint/format and source-only 725-root typing pass with stable inputs.
Build06 produces eight isolated bundles from 973 source inputs and preserves
all 145 protected compiled artifacts. Human localhost bundles are not promoted.

The actual Chrome/Apple Metal grass-storage-native01 fixture passes both active
fine-meadow LODs with nine clumps each at 1.25s and 3.75s wind phases. Ordinary
and storage paths have exactly equal color/received-shadow pixels. Wind changes
18,042 and 10,180 pixels; first-phase shadows affect 2,679 and 1,581 grass
pixels. A translated/yawed parent is included. GPU matrix readback matches
CPU identity bytes; unchanged/wind frames issue zero matrix uploads. Three
vertex storage bindings and seven vertex backings fit the device's limits of
eight each. Actual precompile and both LOD owners dispose root, visibility and
matrix allocations exactly once. All fixture workers, browser, HTTP and
renderer resources close. The inspected comparison sheet is a raw linear
correctness preview, not approved meadow color/lighting/art.

Native09 reaches 14 actual fishing resources and 65 observed grounded chunks
with private storage matrices, but fails the same 30-second pond transition.
Its instrumented trace still attributes 22.16s of 29.88s to native writeBuffer;
25 jobs remain in the last observation. This does not establish a speedup or
regression against earlier non-matched runs, nor prove transfer bandwidth is
the bottleneck. Native10 also fails, with 14 jobs in its last observation.
The emitted per-pass GPU times must not be summed or treated as exclusive
costs before checking actual resumed-pass timestamp-slot ownership.

Native11 proves that attribution defect: 2,580 allocated intervals correspond
to 3,870 actual native passes and 1,290 framebuffer-copy resumes. Every resume
uses mismatched descriptor indices, another encoder's UID and repeated slots
within that same allocation generation. Both per-frame depth-copy resumes
occur while drawing WaterQT_elevated_haven_pond_water; main context 0 reuses
sun-shadow context 6's indices. All bounded counters are complete with zero
overflow. This invalidates native10/11 per-pass cost attribution; it is not
proof that timestamp tracking (normally disabled) causes production slowness.
The diagnostic view still fails its scalar-read deadline. Query pools and all
observer/camera/clock hooks restore, and the owned browser closes. Next use
independently owned per-actual-pass queries, or a calibrated isolated fixture,
before interpreting GPU intervals. Do not silently patch vendor defaults.

Native10 additionally records 2,194,944,230 nominal texture bytes across 321
textures. Three's accounting is not a measurement of resident GPU memory;
pair actual texture owners with native allocations before changing assets.
Do not make further vegetation/batching/texture changes solely from CPU
write-call samples or these unqualified timing numbers.

Read-only texture audit does not identify the dominant allocation. Known source
sizes for seven 1024-square compact terrain maps are only about 37.3 MiB with
mips; outdoor atlases add about 18 MiB. Large disabled impostor arrays must
not be counted as live allocations without evidence. ModelCache deduplicates
resolved model URLs, while separate GLB/LOD images and converted DataTextures
can still duplicate content. Next, census real native texture creation and
logical destruction from before world boot, then attribute those allocations
to actual cached material and submitted-binding owners. Preserve resolution,
mips, sampling and color spaces. Share only proven byte-identical images with
identical rendering state and correct leases; do not guess from file names.

The route audit also preserves a concrete unadopted candidate: pond center
425,415; tighter campus x336..397/z365..421; public preparation connectors
x344..406/z336..363 and x397..406/z350..382. Real server paths can shortcut
across campus despite road paint. First test the actual destination planner;
if necessary, enforce opted-out agent admission at the shared traversability
seam, not through death/drop exceptions. Preserve diagnostic-only custody
approval and exact boundary/overlap semantics. These are planning bounds, not
approved physical access, rendered terrain or economic-zone qualification.

Local evidence: inland-pond-integration01-UNQUALIFIED/build06,
isolated-build06-report.json, native09–11 and grass-storage-native01;
service-layout-network01-UNQUALIFIED/grass-storage-* contains CPU receipts.
LAYOUT-01–08, final pond art, route/custody separation, simultaneous all-tier
fishing and sustained frame/loading/memory acceptance remain open.

## Pond follow-up — all-tier client coverage and upload diagnosis

Native03 reaches the real client with 14 fishing entities, exactly two for
each of the seven families. That verifies replication, not simultaneous
fishing capacity, supply/bank routes or economic-zone admission. The pond
remains an isolated candidate; LAYOUT-01–08 remain open.

Per-job observations record 57 distinct keys/continuations, monotonic sampled
work and stable camera/terrain focus after the initial update. The unchanged
30-second grass transition still fails. This is observed serialized work,
not an established invalidation loop. Native04 CPU sampling redirects the
investigation: 20.96s of native buffer-write samples in a 29.85s trace, of which
19.995s is inside shadow binding updates. Driver/GPU backpressure can appear
at that call, so native timing alone is not proof of redundant transfers.
Native05–07 count exactly one sun-shadow render per main-scene render.

Native07 then proves a concrete redundant path by reference identity:
16 actual 512-slot instance matrices become 32,768-byte raw uniform buffers,
each updated 507 times during 507 shadow renders; eight observed owners are
empty. The installed Three r186 raw NodeUniformBuffer does not track matrix
attribute versions. The scoped source candidate changes only the GLB tree
and resource pool constructors to storage-backed matrices. It retains the
exact initialized array, capacity, static usage and existing dirty/LOD/slot
protocol. The storage attribute is registered on each private pool geometry
for renderer-owned disposal. Pool cloning is outside this helper's contract.

- Actual World/ClientLoader/HTTP GLB owner-lifetime suites and real Three
  matrix/bounds/raycast parity: 20/20 tests pass (including four added cases).
- Source-only 723-root typing including both changed test files: zero
  diagnostics and stable inputs. Scoped ESLint, formatter and diff checks pass.
- Build05: eight isolated bundles, 973 source inputs and all 145 protected
  compiled artifacts unchanged. No package installation or lockfile change.
- Native08 removes the raw 512-matrix uniform bindings, but does NOT close
  the performance gate: the pond cut still fails at 30s with 13 jobs in its last
  per-job sample. About 20.7s of sampled buffer-write time remains; attribution
  now includes raw grass/vegetation instance matrices in the main scene.
  This is a scoped unnecessary-upload fix, not proven sustained FPS recovery.
- All native03–08 test browsers close and diagnostic controls restore.
  Runtime03 and runtime04 shut down cleanly and removed only their own private
  client/server processes and disposable databases. Human localhost remains up.

The actual Apple Metal `storage-native03` fixture now passes: exact initial
and final 256 × 256 color and isolated-shadow pixels; all 32,768 matrix bytes
agree across ordinary CPU/native upload and storage GPU readback; zero matrix
uploads in three unchanged frames both before and after one dirty mutation.
That mutation causes exactly one upload and changes 3,358 color/1,640 shadow
pixels. Both passes bind the same read-only allocation within device limits.
Disposal calls real GPUBuffer.destroy once, removes backend ownership and
native validation rejects a subsequent use. No console/page/GPU errors escape;
renderer, observers, Chrome and owned HTTP port 3345 clean up. Native01 of this
fixture failed because manual same-frame renders reused Three's shadow map;
the verifier now uses distinct real animation-loop frames, not forced shadow
internals. Native02 passed; Native03 adds actual GPUDevice adapter identification.
The root inspected the generated fixture contact sheet. This is static-helper
correctness, not complete tree wind/dissolve or game-world visual acceptance.

Qualify the relevant grass/vegetation owners separately before extending this
optimization. Grass has private cloned chunk geometry and one-time identity
matrices. Vegetation has dynamic usage and alternate screen-space LOD geometry
ownership that require a separate disposal/update contract.
Do not reduce density, shadows, resolution, terrain accuracy, timeouts or work
budgets. Native final art, full streaming, route/custody separation and the
pond's multi-agent gameplay acceptance are still open.

Local receipts: `inland-pond-integration01-UNQUALIFIED/native03–08/`,
`isolated-build05-report.json`; `service-layout-network01-UNQUALIFIED/`
contains `instance-matrix-storage-tests01`, scoped lint and
`instance-matrix-source-types01`.

Primary implementation references checked against installed r186:
[storage instance attributes](https://threejs.org/docs/pages/StorageInstancedBufferAttribute.html),
[instance accessor source](https://github.com/mrdoob/three.js/blob/r186/src/nodes/accessors/Instance.js),
[shadow-node contract](https://threejs.org/docs/pages/ShadowNode.html).
The reference examples guide investigation; they are not performance evidence
for this game.

## Bounded large-bank refinement — native startup recovered, transition still open

The follow-up fixes the exact native01 terrain-cap failure. Broad full bank
rings whose unconditional fine lattice would exhaust the existing vertex
allowance now start coarser and refine under the same canonical error criteria,
retaining the original finest step and forced seam detail. Associated outer
shoulders use the same bounded hierarchy. No vertex, triangle, face-per-cell
or geometric quality cap is raised, and no source landform is changed.

Dense checks caught a new thin-strip shading regression: asymmetric hanging
edge cuts produced a12.91-degree face-normal deviation when center-fanned.
Propagating only required cuts across these broad-bank strips and sampling
their added vertices canonically repairs the witness to0.0930968975degrees,
matching historical fine geometry. Blanket skinny-cell refinement was rejected
because it exceeded the unchanged cap. Intermediate failures remain retained.

- Exact410,415 candidate: four real terrain leaves,169,560 indexed/canonical
  probes, maximum height error10.988mm and face-normal error3.097degrees under
  existing20mm/6-degree gates. Largest surface79,798 vertices,63,414 extra
  vertices (2,122 headroom) and370 maximum faces per cell.
- All four shared-edge vertex, normal and skirt comparisons match. Historical
  small-pond buffer hashes remain exact. Other basin placements, including
  the suggested425,415 layout, are not qualified by these receipts.
- Focused inland gate2/2; art03 geometry/water59pass with one candidate-only
  skip; stock58pass with two candidate-only skips across actual matched suites.
  An initial mistyped water filter matched no suite and is not counted.
-720-root explicit source/test typing, ESLint, formatting and whitespace
  checks pass. Production SHA44a2ed286606f2b9e1d6fd0a4497883a4c3f7e278bc06f389c38a0ebf5d089c5.
  Source receipts are `inland-refinement-*` in the existing local evidence.

Build04 pins972 source inputs and leaves all145 protected artifacts unchanged.
Native02 on actual Chrome/Metal passes the unchanged startup readiness check:
29/29 terrain,122/122 initial-camera grass, and ready conforming water topology
(55 partition leaves,53 water chunks). This resolves the observed startup-cap
failure, not the whole visual/streaming requirement.

The subsequent diagnostic pond-camera cut fails its unchanged30-second grass
settling deadline: four grounding jobs and one LOD swap remain, with no failed
or cancelled grass jobs reported. The controls restore and owned browser
closes. No finished art screenshots,14-fish client assertion or sustained
performance gate was reached; the captured image remains the stream loading
screen, and no full-stream readiness is claimed. CPU regression jobs overlapped
part of this run, so it is not a controlled performance benchmark. Diagnose
actual work and verifier camera ownership rather than hiding the overlay,
extending the deadline or reducing quality to obtain a passing image.

Planning also identifies a potentially useful15m eastward pond translation
plus a tighter, explicit arena safety envelope. That remains unadopted: the
bank bypass must not trigger arena evacuation or introduce unclassified
external-value custody space. Full route/zone admission and live economic
boundary tests are required before any canonical placement promotion.



## Complete fishing candidate and timber docks — source checkpoint, native load failed

This opt-in slice adds all-tier fishing coverage, relocated habitat, fitted
timber art and a pond-to-bank paint route to the isolated inland basin. It does
not relocate canonical assets or change the human localhost world. All
LAYOUT-01–08 acceptance gates stay open.

- The body-bound resource owner requests14 positions, two per seven families
  covering12 fish. It uses real wet targets, canonical ground and dry approaches
  within the existing interaction range. Existing registration leases reserve
  pending targets, roll back failures and constrain relocation to the same
  explicit water owner. Legacy resource admission remains unchanged.
- The detached manifest keeps fisherman_pete's quest/store identity, moves him
  beside the pond and adds feathers to existing fishing supplies. No item price,
  reward, level, custody disposition or economic policy is changed.
- Two merged dock meshes have closed12cm-thick plank sides and undersides,
  member-local filtered timber grain and rough PBR shading on one shared opaque
  material. Walking-top buffers stay byte-exact. Geometry totals are2703
  vertices/1432 triangles and3063/1576; these are not measured draw/frame costs.
-28 habitat instances form three unequal groups with protected dock/supplier
  approaches and exposed plant roots. Contact substrate follows the admitted
  new bank, avoiding stale paint at the old site.
- Actual RoadNetworkSystem startup initially rejected the old pond-bank path
  crossing the lobby. The opt-in replacement uses the lobby–hospital gap and
  landing/Pete approach; canonical-ground checks keep its full painted width
  dry without relaxing other water/floor exclusions. Paint is not proof of
  actual end-to-end collision navigation.

### Source verification

Local evidence: `service-layout-network01-UNQUALIFIED/`.

- `bound-fishing-tests07`:28/28 resource tests, including9 new real-system
  fishing cases, one unchanged historical mocked test and18 existing real
  registration cases. Actual typed spawn data fixed a test-only subtype error.
- `dock-timber-final-stock01` and `dock-timber-final-art03-01`:18/18 each.
  Closed-solid topology,20 additional upward native/mesh probes and86 existing
  downward contact probes pass under unchanged tolerances.
- `inland-habitat-tests02`:111/111 habitat, palette and actual emitted-worker
  cases. `inland-path-regressions01`:77/77 path/configuration/worker cases.
  `inland-candidate-admission-review01`:20/20 world-config cases.
- `pond-integration-types-final02`:720 production plus explicit test roots,
  zero diagnostics, stable hashes. Scoped final ESLint/Prettier/diff checks
  pass. Two missing terrain-interface declarations were corrected type-only.
  Suite counts overlap and are not summed as independent coverage.

### Actual native failure and remaining launch gates

`inland-pond-integration01-UNQUALIFIED/` contains three detached builds and
the real private-runtime/native01 receipt. Eight bundles have972 pinned source
inputs; build02 and the type-only corrected build03 are byte-identical. All145
protected compiled artifacts are unchanged.

The private server's database, manifest and world-identity admission passed.
Native01 used headful Chrome, actual WebGPU, Apple M5 / ANGLE Metal,
1280×720 atDPR1. It failed the unchanged90-second scene-readiness deadline:
`quad_68_d4_450_450` repeatedly exceeded the terrain-collar vertex cap,
leaving28/29 terrain chunks and conforming ocean topology pending. The retained
screenshot is a loading screen. No completed pond/dock art views,14-entity
client proof or performance acceptance was reached. Do not bypass readiness
or raise geometry limits to classify this run as successful. Missing-cow
placeholder and disabled-stream503 logs are retained, not claimed error-free.

The owned browser closed; runtime01 stopped its own client/server and removed
only its disposable database. Protected human service identities and bundle
hashes matched before/after. Localhost3333 was not restarted or replaced.

A separate gameplay blocker remains: the broad arena rectangle overlaps some
new fishing shore. Current rules would preserve inventory on ordinary deaths,
forbid ground drops, evacuate opted-out agents and permit lobby challenges
there. Ordinary gathering keeps its tool/level/consumable/custody authority and
no automatic PvP opening was found, but this placement must not be promoted
until zone/placement policy and real integration tests resolve the mismatch.
Full-bank journeys, simultaneous fishing, persistence/restart, all views,
daylight/night, frame time and memory remain unqualified.

Timber uses the existing [Three.js PBR node material](https://threejs.org/docs/pages/MeshStandardNodeMaterial.html)
and bounded [indexed geometry](https://threejs.org/docs/pages/BufferGeometry.html);
those primary references do not imply visual approval.



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
