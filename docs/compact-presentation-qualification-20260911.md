# Compact presentation qualification — 2026-09-11

**Implementation candidate; not final art, sustained performance or launch approval.**
This slice follows shared-lighting checkpoint
`e3540612e9764c9584ebbd1ded389a290e8fd244`, pushed with exact remote and GitHub
author/committer `dreaminglucid` verified. Its day/night limitations remain in
[outdoor lighting qualification](outdoor-lighting-qualification-20260911.md).

## One authoritative arena

- Shared columns/rows/count are all one. The paired arena manifest retains only
  ID1. Its 20x24m combat bounds, spawn points, lobby and hospital are unchanged.
- Floor generation, perimeter collision and combat containment use that same
  configuration. Retired rings must not survive as hidden collision or combat
  regions. Explicit invalid layout overrides fail closed.
- The campus grade shrinks from104x140.5m to104x84.5m; its new center is
  (368,390.75), with the existing height unchanged. The full lobby/hospital/ring
  union determines the padded area bounds: x316..420,z348.5..433.
- This removes five duplicate480m² arena floors and5,824m² of broad campus
  grading. It does not finish island composition or redesign the retained large
  lobby and hospital. Island radius/envelope and LOD budgets are unchanged.
- Streaming retains exclusive reservation of ID1. Ordinary requests receive
  `NO_ARENA_AVAILABLE` before rate-limit consumption or walk-to-target when busy.
  Capacity is checked again after delayed movement and authenticated acceptance;
  final allocation remains atomic. No wager or settlement behavior is changed.
- Semantic comparison preserves all authored arrays:16 resource placements,
  eleven NPC placements, seven mob spawns and eleven stations. This is not a
  census of procedural live resources or proof of unchanged replenishment.

Actual DataManager content identity changes from
`d2cbd050bf4194e9c95b90a3fc6be6b19aec66532c28f602183091cbe947a84c` to
`a0a4a5d7f298d2492c07f68a48736351e8e2f2d95e65c9385251a350f7eda78f`.
No user database or persisted wager was deleted or rewritten.
The paired asset-manifest checkpoint is
`d6f52841f5d9173247e4499902ba1c27f96c2a89` on
`codex/duel-arena-launch-assets`; apply it with this game's one-arena candidate,
not independently to an older six-arena runtime.

Independent follow-up review found no double reservation or leaked pending
session in the new rejection path, but client outcomes need finishing before
this is launch-qualified. A consumed invitation rejected for capacity currently
notifies only the accepting player. An inherited final-confirmation path resets
server acceptance after allocation failure without broadcasting the reset;
the first accepter can retain a disabled confirmation button. Notify both
participants, explicitly retire the failed invitation and verify retry after
capacity returns with real socket/UI assertions. The existing server test
passes do not cover those presentation outcomes.

## Resource trees use the world's lighting

The prior tree output replaced native lit RGB with a separate warm/cool ramp,
additive glow, rim brightening and saturation treatment. It retained only native
alpha, and tree batches did not receive shadows. Thus the presence of scene IBL
did not establish tree lighting coverage.

The compact candidate uses a small standard-node-material subclass. It executes
the installed r186 diffuse/opacity/discard setup, then replaces **RGB only** with
authored textured/snow albedo before standard lighting. This is necessary because
vertex colors encode leaf/AO masks and batch colors encode hover/snow/depletion;
they are not RGB tints. Simply returning native lit output would multiply those
mask channels into color. Native lit RGB now reaches the existing hover/fog output,
and vertex-G AO feeds the native indirect-occlusion stage.

This follows the installed r186 material ordering, not an assumed renderer API:
[r186 NodeMaterial source](https://raw.githubusercontent.com/mrdoob/three.js/r186/src/materials/nodes/NodeMaterial.js)
and [NodeMaterial output documentation](https://threejs.org/docs/pages/NodeMaterial.html).
That documentation distinguishes modifying final output from bypassing the
built-in lighting evaluation; neither route alone demonstrates correct pixels.

The existing cutouts, screen-door depletion, wind, hover, fog, source textures,
geometry, batching capacities and LODs remain. Compact batches receive the existing
scene shadows, without additional shadow cameras or new shadow-map resolutions.
No private environment maps or extra lights are introduced. This can still add
real shading/shadow-sampling cost; unchanged geometry is not a performance result.
Leaf transmission, canopy silhouettes, shadow acne/shimmer and distant transitions
remain visual/motion gates, not assumed consequences of using PBR.

The immutable material receipt `treeLighting.mode = scene-pbr-mask-safe-v1`
records the selected implementation policy. A marker is not shader execution or
pixel evidence, and a marker-based scene scan is not an independent resource census.

## Fishing resource transforms

Probe27 recorded authoritative fishing Y27.8 but live node Y26.98265471132156.
Real `ResourceEntity`, `ClientNetwork`, terrain and `TileInterpolator` tests
reproduce that exact0.817345m drop in both packet orders. Generic remote quaternion
updates had enrolled a resource in character terrain-following interpolation.

The resource-only network path now clears character interpolation, validates
transform aliases before modifying canonical data, and updates node/config/data
together. Dedicated fishing movement uses the same position application. Actual
character gradual facing and terrain following remain unchanged. Dedicated
depletion handling and ordinary metadata updates remain intact.

This does not qualify fishing marker/particle ownership, shore accessibility,
authoritative relocation lineage or long-running synchronization. The old static
initial-XZ study failure is preserved; no fish movement or admission gate is waived.

## Verification before actual capture

- Shared arena/worker/grass suites:128 tests across ten files pass.
- Server arena/admission suites:167 tests across six files pass, including four
  new real-class tests and an actual loopback WebSocket rejection receipt.
- Tree/material suites:171 tests across five files pass, including six new actual
  r186 class/TSL/WGSL-boundary regressions. No GPU renderer was substituted.
- Resource/character suites:25 tests across four files pass, including eight new
  real-class regressions. These tests are not browser or GPU observations.
- Shared, server and client typechecks pass. Normal client build and its five-task
  dependency graph pass; fresh server competitive-build prefix is `51a859314bd0`.
  This does not certify a full all-package monorepo build.
- Paired manifest verifier and launch asset preflight pass. Scoped lint, format
  and diff checks pass. Existing cow/dagger content failures remain unqualified.
- New external runner14/study14 execute the unchanged study13 camera/resource/
  geometry/error gates, then require exact three-floor ownership and bounded
  actual tree-policy observations.52 harness tests pass. One historical test
  requiring eight floors is explicitly excluded by exact name; its successor
  repeats every assertion and replaces only that count with the exact three
  retained floor names. Historical files/captures are unchanged.

## Actual integrated capture

Probe28 **failed before any images or spatial study**. It ran from
03:25:34.945 to03:26:49.977UTC on2026-09-11, using the frozen runner14/study14
candidate and fresh server build above. Its immutable report SHA-256 is
`76b853b81d0ffc6b7cae4d4c462df09ea012d705c44af930032c6eb40d5c0164`.
All309 current pinned source files independently match their recorded hashes.

- The first diagnostic dagger equip received HTTP200 at03:26:26.832. The
  unchanged15-second equipment-event admission timed out at03:26:41.833.
  The actual client event arrived at03:26:46.150, approximately19.318 seconds
  after the successful server receipt. The observer subsequently attached it;
  owned cleanup then unequipped it. This is a responsiveness failure, not proof
  of an enduring missing item or equipment identity mismatch.
- Even the first cleanup page evaluation waited until03:26:46.164. This places
  the failure around client/frame/queue progress. It does not yet distinguish
  CPU node generation, native pipeline compilation, upload work or networking.
  The retained native texture trace covers only about1.45 seconds near the
  delayed event and dropped9,843 earlier events; it cannot attribute the stall.
- There were zero recorded GPU validation or page errors, six content console
  errors, and the existing cow404/dagger-fit failures. Twelve real environment
  maps were ready;468.1ms is observed startup elapsed time, not isolated GPU cost.
  No image, rendered tree-shadow, compact composition or performance approval
  follows from those successful properties.
- Browser and owned services exited, all four owned ports were free, and harness
  cleanup errors were empty. Separately, the launcher log records a shutdown
  `player_sessions` update attempting to use the database pool after it ended.
  Process cleanup succeeded; application shutdown was not error-free. Preserve
  this lifecycle defect separately from the earlier equipment timeout.

The shutdown source path is now identified: `PersistenceSystem.onPlayerLeave`
awaits a session read before issuing the session-end write. These asynchronous
delegated operations are not in the shutdown pending-operation set, allowing
pool closure between them. Track and await leave-persistence completion before
closing the pool, and reproduce a disconnect paused between the two queries.
Do not hide the error or discard the final session write.

Source inspection and a real-class CPU check did not find a repeating sky-map
or tree-metadata cache invalidation:1,000 swaps between real precomputed targets
kept environment/material keys and versions stable. Tree batches do enter the
scene without a precompile step; first-use node/pipeline work is a hypothesis,
not an established cause. Diagnostic node stack capture can also add overhead.

Next: an immutable successor harness must record bounded long-task/frame,
native pipeline and actual network/frame progress timings, plus failure state
before unequip cleanup. Keep the15-second admission, error and identity gates.
Label instrumented timings as diagnostic, not benchmark evidence. Only change
the runtime after attribution. The combined tree/arena presentation remains
visually unverified; before/after scene-property observations are not per-image
receipts, rendered-shadow proof or sustained-performance evidence.

Chrome's [Long Animation Frames guidance](https://developer.chrome.com/docs/web-platform/long-animation-frames)
explains why separate short tasks can still produce a delayed frame, and why a
bounded observer is preferable to relying on the finite performance timeline.
Use both frame and task entries alongside actual application timings. They do
not measure GPU execution, and absence of a greater-than50ms entry does not
establish a60fps frame budget.

## Remaining visual priorities

### Probe29: actual images and main-thread attribution

The successor run completed the spatial study and all37 admin receipts on
2026-09-11,03:45:31.317–03:47:57.517UTC. It retained28 PNGs, zero recorded
GPU/page errors, and the existing19 cow/dagger content errors. The whole run
**still failed**: the launcher reported a process-group inspection `EPERM`
during shutdown. Its later diagnostic snapshot showed the owned client leader
as a zombie; all owned ports were subsequently free. That does not invalidate
the observed permission failure or authorize changing the cleanup verdict.
All316 current source pins,247 archived source files and28 PNG hashes were
independently verified; every captured PNG is1280x720.

Immutable report identities:

- Main report: `c0aa167d7daa92f8770463dcfbc9aae78a01b7a9229b421f49454b3b56668b68`.
- Spatial study: `0a9e7906105e4d20358c8592058b366e717b8984b0176db4a6c08e243ae4feb2`.
- Presentation receipt: `3d3b551076bc6260700aba482d98fe4b5823daf6a2fe68efd516e6ee3060246d`.

The two bounded scene observations preserve the identities of42 tree batches
and42 materials, all with the compact mask-safe policy and cast/receive flags.
The floor receipt and actual wide view show only the retained arena, lobby and
hospital. Neither is proof of a complete resource census or rendered shadows.

Actual visual review still rejects this as final art: crowns remain dense and
harshly colored, the island is a largely empty green surface, paths and platforms
feel disconnected from the landscape, the pond is an engineered bowl, bronze
reads very dark, and the stream overlay obscures faces. One arena is now visible;
that structural improvement is not a finished island composition.

Timings identify a major **synchronous rendering** stall in this instrumented
run:357 node builds total55,329.7ms, compared with5.7ms of synchronous native
render-pipeline invocation across288 calls. The longest actual `graphics.render`
call takes9,556.5ms; a later spatial call takes6,230.7ms. Individual equipment
handlers remain at or below1.8ms. The apparently slow empty-queue `flush` Promises
enclose those synchronous renders and settle afterward; they are not evidence
of a slow packet handler. Async pipeline settlement timings also include main
thread scheduling and are not isolated GPU compilation measurements.

Do not attribute all node-building time to trees: only16 individual node-build
rows survive the shared bounded timing rings, including one tree row. Counts
cover all observed materials. The run also enables diagnostic node stack capture,
which can add substantial node-construction work. Next run must retain all
graphics/error/admission settings while leaving the actual canonical default
`Node.captureStackTrace=false` untouched. Compare that diagnostic-overhead control
before deciding which runtime shader-preparation changes are warranted.
These timing categories overlap and must not be summed. In this run the first
dagger event arrived4.3ms after its HTTP receipt; the earlier15-second admission
failure did not repeat. This does not identify the exact operation responsible
for probe28. A separate three-second native macOS sample was collected near the
end of probe29, not during its largest initial stall; mostly unsymbolicated
JavaScript frames prevent useful material attribution from that sample.

There is a separate, concrete presentation ceiling: both existing stream render
profiles specify `shadows: none`, and `StreamingMode.tsx` also unconditionally
sets that preference. `Environment` consequently creates a non-shadow-casting
sun. Probe29 confirms the actual sun flag is false. These captures therefore
**do not exercise resource-tree shadow reception**, despite eligible batch flags.
After the isolated timing control, implement and qualify an explicit high-quality
stream candidate with coherent shadows/contact and retained resolution; do not
silently relabel the current shadowless capture as the final graphics target.

### Next composition and qualification work

Probe30 completes the default-setting control with no runtime/asset changes:
352 synchronous builds total2,519.7ms (one>=50ms), compared with357 builds and
55,329.7ms (261>=50ms) under optional stack capture in29. The actual canonical
default-false descriptor remains unchanged at attachment and cleanup. This is
strong evidence of diagnostic node-stack overhead, **not a production speedup**
implemented in the game. Other instrumentation remains active. Different frame
counts, natural daylight waits and dynamic actors prevent treating total elapsed
time or mean render time as a controlled steady-state FPS comparison.

The longest instrumented render is still1,099.2ms and a spatial render takes211ms.
Residual production cost is unqualified: the remaining native texture trace
serializes47,931 records and captures398 stacks, in addition to per-draw reference
tracking and18,411 timing records. Its retained history does not cover either
spike. A separately labeled low-overhead control must retain the same scene,
quality/cameras and console/GPU errors while omitting heavy per-call tracing;
that control would not supply the native-lifetime proof retained in30. Do not
attribute these spikes to app/driver/GC work without that separation.
Study and all37 admin receipts pass, with
28 PNGs, zero recorded GPU/page errors and clean owned browser/service/port
cleanup. The whole run still fails the19 cow/dagger content errors. All320
current source hashes match. Main report SHA-256:
`968d8f4d798f3eb1b6c030b55231f1d8d30ab2e8468df5d486b981b2d8e2fd31`.
Spatial report:
`c470d0f97f3db5b1d4e4fe0ca6cf88415ae5e2b3ddf2a431705e4b94419ff5ba`.
Presentation report:
`6ab8142073b78083c216068484ca271b97cdd8c65001134c26b805d6383b79f6`.

Keep default-false capture for subsequent normal-state controls and use stack
capture only as a labeled error-attribution tool. Next implementation is an
opt-in shadow-enabled stream profile with actual applied-state verification,
including stored-preference conflicts and capture URL selection. Existing
canonical defaults are not silently promoted or relabeled. Then qualify fitted
shadow coverage, remaining cold-work hitches and the full composed landscape.

Compose the reclaimed island as a landscape rather than a flat campus: strong
landform and shoreline silhouettes, integrated paths and preparation buildings,
actual resource-tree groves, restrained understory and believable ground contact.
Qualify daylight and night skin/metal readability, shadows and foliage in motion,
water, animation and sound, normal gameplay delivery, reconnect and actual stream
output. Measure representative frame-time tails, loading and resident memory on
explicit hardware/population settings before any performance or launch promotion.
