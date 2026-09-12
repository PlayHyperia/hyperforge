# Compact grass: live per-blade integration

Status: implemented; CPU/build tests and native69 scene/binding regression pass.
Native68 remains rejected for an obsolete observer material-identity assumption.
This is not visual, GPU-budget, motion, or production-launch acceptance.

## What changes

The compact-island profile now stages raw placement results until their actual
retained terrain triangles and neighboring support are available. One manager
advances one resumable job per update, with a cooperative 2 ms target and
bounded charged work. Input copying, anchor projection, per-blade fitting and
provenance compaction use that same continuation. A complete result alone may
create a mesh or mark a valid empty chunk ready. Missing terrain sleeps;
malformed inputs or exhausted work budgets remain failed for that input epoch.

Each installed clump retains twelve blades. Each blade has two float32 endpoint
corrections in chunk-owned read-only vec2 storage: **96 bytes per clump**. The
vertex shader addresses this with integer instance/blade indices, interpolates
between the endpoints using the original UV, and adds the correction after
the existing scale/fade/rotation/terrain-tilt/wind transform. It is not faded
away with blade height. No change to seed, raw placement, density, blade shape,
lighting, camera, resolution, or ordinary/fixed-profile admission is included.

Accepted bounds include all original vertices, both fade endpoints, and the
full declared wind envelope. Rejected clumps do not inflate the installed box.
Chunk and instance transforms retain their existing identity rotation/scale.
The geometry owns its correction allocation; its cloned material borrows shared
base nodes, uniforms and maps. Rebuild, invalidation, horizon departure and
destroy retire the chunk's geometry, material and instance resources together.

## Ownership and readiness

Terrain leases include newly arriving neighbors, replaced/unloaded geometry,
and transition-parent exclusions. Constraint queries and invalidation use the
full potential blade envelope, not only the previous half-meter normal stencil.
Water leases detect relevant arrivals and changed primitive properties.
Supported pad and road changes use TerrainSystem's existing invalidation and
rebuild lifecycle. Arbitrary direct mutation of a registered pad's internal
mask is not a supported update API or an independently polled epoch.

Readiness requires the completed terrain and constraint owners to remain
current. The additive grass diagnostic reports running, waiting, failed,
cancelled, completed and valid-empty counts plus correction bytes and measured
active-slice elapsed time. Empty output is distinguished from incomplete work.

## Verification so far

- 968 shared tests across 76 files pass, including independent Three quaternion
  transforms over all three LODs, fade/wind bounds, rejected/empty bounds,
  actual terrain-manager neighbor arrivals, stable waits, water invalidation,
  missing-owner failures, independent bindings and exact CPU disposal events.
- The original six production-worker leaves still yield 2,298 raw clumps.
  Fifteen external tests compare every preexisting result field against the
  immutable original algorithm, including the 2,240 retained clumps under that
  original query. New live expanded queries are separately admitted; the old
  count is not forced onto their output.
- Shared, client, server and external typechecks; scoped ESLint/Prettier;
  client/shared and then server builds pass. Native-capture preflight passes
  100 checks, retaining every previous camera/daylight/error gate. Its exact
  closure is 596 prelaunch sources plus 12 known dynamic equipment pins.
- Native68 uses the real nonfallback WebGPU runtime and a passive observer of
  actual chunk bindings, allocated GPU buffers and compiled vertex source.
  It installed all 2,240 clumps and 215,040 correction bytes with six current
  terrain/constraint owners and no pending/failed jobs. Four chunks already
  had native storage allocations at the first observation. Compiled WGSL uses
  unsigned `instanceIndex * 12u + vertexIndex / 5u` and original-UV endpoint
  interpolation after the base transform. This subset does not pass the run:
  the old grass observer rejected cloned chunk materials before counting any
  instances. Its zero count is failed observation, not an empty native scene.
  The failure report is retained with SHA256
  `0fb48002cb8fc33ded60c85343090f8dc9a9da346a19f7e52ebcb7bfe58d2ed3`.
  No page/GPU/cleanup errors; the old 19 cow/dagger errors remain; all owned
  processes and ports closed. Native68's longest active slice was 7 ms.
- The observer successor validates the exact original base-node reference,
  zero-X/Z correction, UV interpolation, read-only chunk storage, uint blade
  address and borrowed shading nodes. Tests exercise real Three nodes and
  reject wrong storage, strides, integer types, UV axes and extra displacement.
  The core otherwise normalizes byte-for-byte to the original observer;
  ordinary-profile identity admission remains. Native69 passed independently.

Native69 evidence: 608 source pins / 539 archives, 24 PNGs and 18 matched
camera/daylight pairs, both complete island censuses and 37 frozen game files
independently verified. Six actual native correction allocations exist at both
boundaries: 2,240 clumps, 215,040 bytes, no pending or failed jobs. The original
anchor/normal/computed-surface and sampled actual-triangle checks also pass.
Report SHA256:
`f334fe9b87ed98f77274941caba6f3f494516739dbd8d953d595bb28ccb16386`.
Root verification is retained in the external
`compact-grass-grounding-integration01/after69-root-verification.json`.

No page/GPU/cleanup errors; the same 19 cow/dagger content errors keep overall
success false. Owned Chrome, launcher and ports closed. All six scenic stills
were reviewed: no apparent new regression, but sparse grass, flat lawns,
continuous ridge walls, dominant rectangular platforms, loosely placed services
and pale sky remain well below the requested art bar. No art approval.

Native69 recorded **570.5 ms cumulative active fitting time and a 15.9 ms maximum
slice**. That misses the cooperative 2 ms target and remains a loading/frame
pacing investigation, not performance acceptance or proof of the cause of any
visible stall. Do not increase density before profiling and addressing it.

An initial external test command used the wrong working-directory/config and
found no tests; that invocation is not evidence. The pinned project Vitest
4.1.10 invocation subsequently passed all 15 external checks.

## Still required

- Native source/archive/image and exact shader-addressing regression is checked;
  this does not replace motion, retirement or whole-scene art approval.
- Native allocation retirement across rebuild/unload/reconnect; CPU dispose
  events alone do not prove that storage allocations are reclaimed.
- Per-blade float32 contact, fade, wind and culling transitions in motion.
- Actual loading/upload/GPU/presented-frame and thermal/scaling budgets.
  Initial raw-worker request construction remains synchronous. Cooperative
  slice timing can overshoot; it is not a hard frame-time guarantee.
- Denser coherent vegetation and the remaining island/atmosphere/character
  art work, plus the documented cow/dagger errors and integrated launch gates.
