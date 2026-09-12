# Natural preparation ground — 2026-09-12

## Change and bounds

Central Haven's 36×36m plaza and six-meter blend used to suppress all grass,
even where the ground is just meadow. Its existing grade now explicitly allows
grass. All automatic station pads remain byte-equivalent at runtime, including
their original core, blend, dimensions and elevations. Existing paths still own
the road mask and full-blade exclusion.

A single authored clearance protects the lodge, roof envelope and foundation
steps, with a 0.5m outward apron: center (350,326.97), 10×12.06m, zero blend.
Its grade equals the surrounding campus, so no new terrain shape is introduced.
The existing grounding pipeline rejects complete wind/fade blade envelopes
against this pad; it does not merely test clump centers.

Only `manifests/world-areas.json` changes runtime content. No station/NPC/resource
moves, new decorative trees, route/collision changes, density adjustments,
rendering settings, shader or engine changes. World-area SHA-256:
`9c9b92b2c03118b24f5002ff313c8177609c1a8112dc0844dedfd44d2aa7890f`.
Full content identity:
`da97b5073b443b0611616369e9ae8ac889daabce19f4765eca08579187567c78`.

Companion assets commit: `8ff713a563a2a03810e222a4808769cd6982bcae`,
branch `codex/duel-arena-launch-assets`. Use this content revision with the
corresponding game tests; the default assets branch has not been merged here.

## Verification

Evidence directory: `asset-studio/compact-smithy-court01/`.

- Real height resolver: all46,431 half-meter-grid positions across the full
  preparation campus/pond compare exactly with the previous layout. Released
  sampled area797.25m² is a grid measurement, not an exact continuous integral.
  The initial greater-than1000 estimate failed and was replaced by the measured
  result; no clearance was reduced to meet that estimate.
- All automatic station pads remain identical. Lodge clearance derives from the
  shared footprint whose genuine generated geometry is covered by existing
  tests. Full worker snapshot now has19zones, including three arena overlays;
  repeat registration, order, water, CPU/worker and rejection checks pass.
- Current six-leaf native-worker raw census is [271,495,212,532,493,349]:
  2,352 total. Sync/main-thread arrays agree. The actual preparation grounding
  fixture installs186 clumps, with42 roots in the formerly bare plaza; existing
  wind/pad/road/water and base-error protections remain active. This fixture
  and the native scene use separate retained surfaces and are not treated as
  identical rendered populations.
- Historical density, content-identity, blade-gap and mask-rephase oracles keep
  their original expectations. They now explicitly reconstruct the previous
  plaza input. Current-layout tests are separate. Initial suite03's eight
  stale-oracle failures are retained, not reclassified as successful execution.
- `plaza-shared-tests04.json`: 1,157/1,157 tests,84files,two workers.
  All shared/client/server typechecks and scoped ESLint/Prettier/diff checks pass.
  Existing built runtime is unchanged; this is manifest-only runtime work,
  verified against the actual loaded content identity in the native session.
- `plaza-preflight02.log`: seven tests preserve runner53's startup, rendering,
  error and cleanup checks, plus exact admission of only the world-area delta.
  Source/archive caps are not enlarged.

Native `game-test-integration/plaza-ground-probe01/report.json` SHA-256:
`7f4388fa84730664d90332d51c5e7c3cbc363e567aa7b8c889fb92d4e1df94c4`.

- Headful Chrome, nonfallback Metal WebGPU,1280×720,DPR1,MSAA4, same eight cameras.
  Actual daylight phases0.461813–0.488010; natural animation/director stays active.
- Six resident chunks,2,275 installed clumps;55 roots inside the former plaza.
  Preparation leaf187 clumps. Existing main-camera render-list membership
  agrees with independent frustum/accepted-world-bound checks at all16 capture
  boundaries. No installed root is in an excluded pad. Count remains stable.
- Versus grass-camera-probe01: +63 installed clumps and +6,048 root-correction
  bytes, for218,400 total. No new grass chunks/materials or higher density.
  These allocation counts are **not GPU cost, presented FPS or scalability proof**.
- Both48-functional-tree censuses and all52 shared dressing instances remain.
  Exact camera restoration, original director resumption, browser/launcher
  shutdown and all four ports free. No page/GPU/cleanup errors.
- Study passes; overall remains FAILED on the same five missing-cow load errors
  and fourteen bronze-dagger missing-fit-metadata errors. Neither is suppressed.
- `plaza-root-verification01.json`: all675 current source pins,596 archives
  (59,151,351bytes) and14 PNG hashes checked independently.

## Direct visual verdict and next work

Root inspected all eight native art views. The bank view visibly regains grass
behind the range and around the pond; service clearances and cutaways remain.
This is a modest restoration, **not a completed composition or AAA acceptance**.
The courtyard still reads as a large uniform carpet with isolated props.
Smithy planting is repetitive/cool-toned; the distant ridge still reads as
rounded synthetic mounds; cliff/shore transitions and the plain sky lack detail.
Static images also cannot qualify wind stability or moving-camera presentation.

Next: author coherent soil/meadow/understory variation using the existing shared
PBR/placement owners, then revise landform/shoreline composition. Do not inflate
texture resolution or clump density without a matched visual and cost test.
Resolve the recorded grounding slice/contention issue before density expansion.
Whole-frame CPU/GPU, motion, target-device scaling and full-loop/streaming gates
remain open; Apple M5 is not lower-end hardware qualification.

Research checked during this pass: Three.js documents
[instancing](https://threejs.org/docs/pages/InstancedMesh.html) for shared
geometry/material draw reduction and
[backend timestamp queries](https://threejs.org/docs/pages/Backend.html) for GPU
timing. AMD's [procedural grass rendering](https://gpuopen.com/learn/mesh_shaders/mesh_shaders-procedural_grass_rendering/)
describes distance detail, root darkening, broad color variation and softer
normals. Its mesh-shader implementation is a separate native architecture, not
a drop-in Three.js change. These are candidates/reference principles, not
evidence that this game's performance or current art is acceptable.
