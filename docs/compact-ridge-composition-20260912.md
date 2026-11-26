# Broken western ridge and island composition — 2026-09-12

Status: verified landform checkpoint, not AAA, performance or launch acceptance.
The current local world selects compact-duel-island-v6 / compact-island-sculpt-v5.
It remains one compact island with one arena. This does not restore a large world.

## What changed

The long western terrace now has two asymmetric saddles and a laterally varying
face. Authoring values are explicit in the world descriptor: northern gap at
z-offset -15 m, half-width 20 m, depth .72; southern gap at +26 m, half-width
20 m, depth .58; lateral warp 4 m over a 96 m wavelength; .6 m broad relief
at noise scale .06. These are authoring coordinates relative to the existing
165 m-radius island. The same function runs in server/CPU terrain and workers.

The coastline/mask, water threshold, service clearings, paths, tree transforms,
resource rewards, grove geometry and lodge recipe/pose are unchanged. The grove
and lodge descriptor profile IDs advance with the terrain; stale world content
is rejected before resource packets. Previous sculpt versions remain numeric
regression fixtures, not alternate runtime worlds.

Current full content identity:
`447db002398498854b548100c68ae5d74560786b8b8758d398140e1bd6a80327`.

Previous v5 content identity:
`198859e9e703e4a1cfd8d09b341d1fb70177a73e894dfcf149c2a529c9cba87f`.

World-config bytes: 16,362; SHA-256:
`3e23ccbde2a8d53dce49a7089a835c65165aaaef482a888f4051b72f63cfc07e`.

## Ground fit and regression evidence

The first shape was not accepted: whole-leaf retained-triangle samples found a
.760600 m mismatch on the southern bent face. Removing relief or warp separately
identified interacting curvature; several narrower trials remained above the
.35 m limit. Broader saddles/warp/relief reduce the maximum to .317505 m, below
the previous terrace's .329778 m sample maximum. This is mesh approximation,
not proof of perfect feet, movement or pixel contact.

Actual production geometry plus native Node workers verify ten 64-grid leaves,
84,420 triangles and 3,450,160 geometry bytes, unchanged from v5. Only western
leaves (250,350) and (250,450) change. Their maximum sampled errors are .206722 m
and .317505 m; pitch remains 100/63 m. No new geometry resolution, texture,
draw pass or density parameter was introduced. Generation cost and native frame
time still need separate measurement.

The broad CPU shape survey changes 1,500 two-metre sample positions, all inside
the previous western support; maximum lowering is 14.509763 m, minimum changed
height 27.793969 m, maximum sampled gradient 2.028629. Every surveyed coastline
and dry/water classification is preserved. C1 joins, independent saddle-depth
oracles, disabled-shaping equivalence, strict field/range rejection, all-field
identity sensitivity and actual worker parity pass.

Shared suite: 1,013 tests / 78 files pass. Old v4/v5 literal geometry and grass
oracles remain; new v6 worker grass counts are [271,495,139,532,493,343], total
2,273, with unchanged density and spacing, plus CPU/worker buffer parity.
The service-clearing before/after buffers remain identical. Current functional
grove integration retains 48 trees and their bounded harvesting routes.

Shared/client/server type checks and builds pass; scoped ESLint/Prettier pass.
Server competitive build manifest prefix: c9a1be67f96f.
Focused capture controls: 33 pass, including seven exact successor/admission
checks, HDR fog, pacing and tree pipeline controls. These controls are not GPU
performance tests.

## Actual native75

Headful Chrome, nonfallback Metal WebGPU, 1280x720 DPR1; same six scenic views,
six initial world/equipment images, natural daylight and .01 phase limit.
Scattering/HDR mode matches native74; this does not promote the optional sky mode.

- 24 PNGs / 21,800,897 bytes; 624 source pins and 555 archived sources /
  57,420,330 bytes. All source/image hashes and 21 frozen game paths verified.
- 18 direct native74 comparison pairs pass; maximum phase difference
  .0098168583. The retained native64 comparison also passes (.0098196063 max).
- Both actual 48-tree content censuses, lodge ownership, HDR fog, compiled grass
  bindings and the 36 tree-pipeline observations pass. Native grass installs
  2,212 clumps / 212,352 correction bytes after eligibility/ground fitting;
  this is distinct from the 2,273 raw worker census.
- No page, GPU or cleanup errors. All owned browser/process/port leases close.
  Overall remains false: five existing missing-cow errors and fourteen existing
  dagger-fit errors remain. They were not suppressed or reclassified.
- Grass fitting still records a 5 ms longest slice and about 508.6 ms cumulative
  active work. No presented FPS, GPU time, motion or long-duration approval.

All six scenic views and the equipped night view were visually inspected. The
ridge now reads as separate knolls in the west-ridge and campus views. That is
a narrow compositional improvement. Smooth/uniform slopes, sparse ground cover,
isolated service props and oversized campus platforms remain below the target.
The night avatar is still cool/dark; this is not a daylight skin/material review.

The immutable report inherits an old human-readable scope string saying
“unchanged v5 terrain.” That label is stale, not the executed profile: its exact
configuration, both live terrain identities, content hash and pinned manifest
are independently verified as v6. Correct that description in the next harness
revision; do not rewrite this historical report or its hashes.

Report SHA-256:
`5e242efd31fd4048e9c0249e6f41f4325a406e0bc049dc9899f8a7a33f4cdb80`
(92,762,959 bytes).
Local evidence: parent workspace `asset-studio/game-test-integration/compact-world-probe75/`;
independent checks: `asset-studio/compact-island-composition-v1/{before75-root.json,verify75-root.mjs,after75-root-verification.json}`.
Failed shape trials remain in that composition directory; they are not acceptance
results.

## Art direction and next work

The imagegen skill produced an explicitly labeled concept used to guide the
broken silhouette and the next coherent service/planting composition. It is
not a screenshot, asset export or quality proof. Exact prompt and saved image:
`asset-studio/compact-island-composition-v1/ART_DIRECTION.md` and
`island-art-direction-concept01.png`. Its distant islands and rock arch are
not implemented or promised as heightfield features.

Next: implement the bounded open smithy/courtyard, then layered rock assets and
low planting around the real resource trees; improve surface transitions and
platform scale. Every new solid needs shared navigation plus actual collider
ownership, not decorative geometry on traversable ground. Continue real movement,
agent-population, resource churn, GPU/submission/presentation and stream-load
qualification before accepting smoothness or production quality.

## Primary research

The current installation is already Three r186. Its
[procedural terrain example](https://github.com/mrdoob/three.js/blob/r186/examples/webgpu_tsl_procedural_terrain.html)
is a reference for WebGPU/TSL terrain, not evidence of this game's performance.
[Renderer documentation](https://threejs.org/docs/pages/Renderer.html) documents
precompilation and renderer statistics; those are not interchangeable with
presented-frame measurements. The official
[timestamp query sample](https://webgpu.github.io/webgpu-samples/?sample=timestampQuery)
demonstrates render-pass duration measurement. The existing local render-cost
audit records the additional r186 descriptor/readback hazards that must be
resolved before introducing instrumentation here.
