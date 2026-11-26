# Compact world foundation checkpoint — 2026-09-10

Status: development checkpoint, **not a visual, performance, MVP or production pass**. The compact island is the only target world; there is no requirement to preserve the large island as a playable alternative. No deployment or main merge is part of this checkpoint.

## Pair the repositories

The foundation game commit `85984a42ca50f959bf221457405fe3beec8aad4c` pairs with assets commit `cd6c447cd473a1a223d7569138531a49e9a63c6b` on `codex/duel-arena-launch-assets` in `PlayHyperia/assets`. This section records that historical pair, not any later grass opt-in checkpoint. Do not deploy just one side. That assets commit changes only `manifests/world-config.json` and `manifests/world-areas.json`.

The admitted world-content SHA-256 is `53c47dbbfd0962e6da465d4c64d41b3240a0c31a94b8f0bd9001d8bf09340620`. It covers eleven placement manifests, not source, every item, art or whole-gameplay compatibility. New clients verify this identity before applying snapshots. Server-enforced compatibility acknowledgement for old clients remains required.

## Implemented foundation

- One validated compact profile supplies the terrain envelope, translated biome centers, seed, shoreline and water parameters to the active CPU and worker paths. Worker output admission rejects mismatched profile identities. Optional procedural towns and all nine POI categories are zero for this authored blockout.
- The generation envelope is X150–550/Z200–600. Island center is (350,400), nominal radius 165 m, falloff 30 m. These are provisional layout parameters, not approved art or performance budgets.
- Existing preparation areas move together by (+350,+320), retaining station/resource IDs and custody behavior. Pond, campus and workstation grades remain explicit.
- Terrain owns the common arena grade and eight floor overlays on both roles. Arena pool spawn heights, ordinary duel returns and egress agree; visual slab tops retain their intentional 2 cm clearance. Lifecycle/index replacement cleanup is covered separately.
- Invalid or out-of-envelope saved coordinates are rehomed through an admitted lobby fallback during character admission and duel restoration. This is not a general walkability guarantee or destructive database migration.
- Bridges and docks explicitly initialize after terrain. One obsolete bridge and one obsolete dock outside the new envelope are removed; reusable generators/renderers remain.
- The launch validator now checks rectangular flat-zone half-width and half-depth independently. It does not expand area bounds to accommodate an invalid placement.

## Verification and limits

- Fresh shared and server builds pass; shared, client and server typechecks pass.
- Combined server regression: **499 tests across 19 files pass**, including duel, preparation, occupancy, restoration, embedded services, prayer custody and network fixtures. Inherited mock/fixture-based tests are not described as live-game tests.
- Focused profile/worker/content/spawn/grading group: **121 tests pass**. Other retained focused groups overlap and must not be summed as unique coverage.
- Actual generated quad-worker JavaScript agrees with Float32 CPU results at **24,576 samples** across six compact regions. Eight integration regressions also cover authored grade vertices, moved zone IDs, index cleanup and repeated loading. Between-vertex triangulation, PhysX and gameplay navigation agreement are separate gates.
- **Nine actual terrain/infrastructure initialization tests pass**, including reverse registration ordering and removal of obsolete deck overrides.
- **13 launch-validator tests pass**, including actual rectangular dimensions, independent-axis overruns and circular water boundaries.
- Source preparation-topology audit passes 59 targets; longest modeled agent run is 5.4 seconds. It does not establish live banking/gathering or full preparation-to-duel traversal.
- Scoped lint, formatting, diff checks and staged secret scanning are required before committing. Unrelated mode-only changes, provider duplicates and package-manager files are excluded.

## Retained actual-run failures

Evidence is local under `asset-studio/game-test-integration/` beside the game repository. Prior runs are immutable.

- `compact-world-probe04`: preflight incorrectly treated a rectangular arena grade as a square. Corrected by the validator changes above; no server/browser qualification came from this run.
- `compact-world-probe05`: server startup exposed an early terrain-init yield before bridge sampling. Corrected by synchronous installation on the admitted-data path plus explicit infrastructure dependencies.
- `compact-world-probe06`: actual headful Chrome/Metal WebGPU initialized without a fallback adapter at **1280 x 720, DPR 1**. Two maintenance agents completed 14 diagnostic equips and 14 unequips with retained custody checks. The required-content study timed out before spatial measurements, so there is no compact terrain visual pass. The study incorrectly expected manifest resource corners instead of the game's snapped tile centers; a new diagnostic version is being prepared without changing this failed evidence.
- Probe06 also records a real **404 for `models/cow/cow.vrm`** affecting three cow actors. The model is absent from the current local/Git assets tree. Fourteen canonical dagger fit-metadata errors remain a separate release blocker; none is silently discarded.
- Probe06 shutdown remains failed because inspecting the owned game-client process group returned macOS EPERM. The later numeric-only sample observed its leader in zombie state and then its close event. This is diagnostic evidence, not proof that ignoring EPERM is safe. Browser closed, PostgreSQL exited, all four owned ports were free, all attachments detached, and source pins were unchanged.

Probe06 receipts:

| Receipt | SHA-256 |
| --- | --- |
| `report.json` | `6281f2f41eaf8b4b7b049cf3d35583c7514b1f47b30e1f1e75af7d87ca13588c` |
| `spatial-study.json` | `f80e2a6246e33de1efaa47e6941c4786f7c861ee170effa5a1ca2953e9107584` |
| `launcher.log` | `3857940f5bf453cb76c648e0263286ebc539bc08a09b7743f4597054f12cbf63` |

The six baseline PNGs are not a complete terrain review: the normal baseline retains the readiness overlay; under-overlay images are explicitly diagnostic.

## Later immutable baseline: probe07

The corrected source-backed tile-snap/resource-ID study completes all 11 views and
22 spatial PNGs in actual headful Chrome/Metal/WebGPU at 1280×720, DPR 1. All
16 expected resources are admitted; terrain-only, combined authored-floor and
per-PNG finite coverage checks pass. There are 37 custody receipts and zero
page/GPU errors. The browser closes, all owned ports are free, PostgreSQL exits,
and cleanupErrors is empty. All 96 source/build/asset pins remain unchanged.

The outer run still **fails**: the missing cow model yields one 404 and five
unexpected console errors. Fourteen canonical dagger fit-metadata errors remain
explicit release blockers. This clean shutdown does not erase the earlier EPERM.
The runner deliberately skips streaming and betting, so this is neither stream
proof nor a complete preparation/duel cycle.

Manual review of island-wide, hub and pond images rejects the current art:
abrupt snow/canyon/forest partitions, oversized terrain cuts, very sparse ground
dressing and a washed-out, poorly integrated pond. Keep these as the before
baseline. Shared grass heights alone cannot resolve composition or material
quality, and matching computed heights does not prove contact with the rendered
triangles between vertices.

Probe07 report SHA-256:
`d629642874cbb63d5da92c49ba7a9dd0efbe29094aff7c38e7d4d02dcb5309e2`.
Spatial study:
`8ce978da41d286ec112a981dc7dd5391a3ca4e132b14a255da857311ee3e8175`.
Launcher log:
`3131818343bb9e992bfbfdec1d0217841081853beb7e4f72bfd2719b881a029c`.

## Next gates

1. Extend the admitted probe07 daylight baseline to a complete daylight/night review, resolve the missing cow model and qualify repeated shutdown.
2. Share final authored-grade/pond heights and normals with GrassWorker; separate grass exclusion from grading and reject stale results after invalidation. Preserve current instancing, LOD, density/range and upload limits for the first correctness comparison.
3. Art-direct landforms, shoreline, paths, materials and vegetation together. Current noise modulation is not hydraulic erosion; terrain roughness is uniform and per-surface normal/roughness detail remains work. AAA is an acceptance bar, not a property of the procedural algorithm.
4. Qualify actual live preparation, banking, dynamic combat, reconnect/restart, streaming, SOL-only betting and representative long-duration performance. Bounds-only spawn admission, generic legacy hydration, road assumptions, old-client admission and startup timeouts remain open.
5. Finish avatar/material/equipment integration and final grip polish without changing approved anatomy/rest/weights. This checkpoint neither edits nor approves those assets.
