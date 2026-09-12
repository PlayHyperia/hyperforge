# Grass visibility follows the rendered camera — 2026-09-12

## Finding and correction

The grass owner previously set each chunk's `Object3D.visible` from the camera
available during the terrain simulation update. The preparation study applies
its final camera later, at render time, while the real director remains active.
Consequently a valid, uploaded, grounded chunk could remain globally invisible
even when the rendered camera looked directly at it. The same design could leak
one camera's decision into later camera passes. Readiness and buffer-allocation
receipts did not detect this problem.

The preparation chunk centered at (350,350) was marked invisible in both boundary
censuses of roof-cutaway-probe02. A regression using the actual terrain, native
worker and grounding pipeline reproduces the failure after a camera looks away.
This is not a justification to raise density or disable culling.

Render-time culling now uses Three.js r186's public
[mesh/frustum intersection hook](https://threejs.org/docs/pages/Mesh.html).
The existing accepted wind-swept bounds are converted once into chunk-local
bounds. Each render pass transforms them by the prepared mesh world matrix and
tests that pass's actual frustum. Scratch belongs to the mesh; no per-pass
allocation or matrix update is introduced. The hook also accepts actual
[multiview frusta](https://threejs.org/docs/pages/FrustumArray.html).

The shader places clumps and applies per-blade corrections while instance
matrices remain identity. Default instance/geometry bounds therefore cannot
describe the displaced grass. Explicit bounds retain the complete accepted
envelope, including wind and fade extrema; culling remains enabled. The earlier
camera only prioritizes bounded LOD work, using its actual coordinate system
and reversed-depth flag. It no longer writes render visibility for every pass.

No placement, density, blade geometry, material graph, correction buffer,
world/terrain manifest, gathering resource, collision or camera is changed.
The ordinary and fixed profiles use their original conservative envelopes;
compact grass retains its tight accepted grounded envelope. The precompile
sample still disables culling intentionally, so its existing compilation
contract remains intact.

## Verification

Logs and test reports below are in the parent workspace's
`asset-studio/compact-smithy-court01/`.

- `grass-camera-before01.json`: the genuine preparation-chunk regression fails
  at the stale `visible=false` result. The wrong-cwd after02 invocation ran no
  tests and is not evidence. After03/04 exposed two incorrect test-camera
  expectations: a camera inside the chunk and a translated chunk still ahead of
  another camera can legitimately intersect. Corrected the fixture poses, not
  the culling policy. After05 passes all sequential/multiview/parent cases.
- `grass-camera-shared-tests06.json`: 1,156/1,156 tests across 84 files, two workers.
  Existing historical worker censuses, physical bounds, storage ownership,
  resource/navigation and native collision checks remain intact. The previously
  recorded grass contention/publication issue remains open; no such failure
  occurred in this run.
- `grass-camera-types-{shared,client,server}01.log` and corresponding
  `grass-camera-build-{shared,client,server}01.log`: all succeed. Scoped ESLint,
  Prettier and diff checks pass. Six native preflights also pass.
- `game-test-integration/grass-camera-probe01/report.json`, SHA-256
  `2884b3399e93efa7f5e30cbdf3dcd957466a5498e384e37402c6da556c8cb9b1`:
  headful nonfallback Metal WebGPU, 1280×720, DPR1, MSAA4, unchanged profile.
- The read-only observer reads the existing main-camera opaque render list; it
  never compiles or renders an extra pass. Independently, the current camera's
  projection/inverse matrices and accepted world bounds determine expected
  intersections. Every chunk's actual list membership matches at all 16
  screenshot boundaries across eight distinct views. The preparation leaf is
  in the actual draw list for meadow, bank and anvil views. Frustum culling is
  enabled and the world traversal is not globally disabled for any chunk.
- Same six installed chunks and 2,212 clumps, including 131 in the preparation
  leaf; same 212,352 root-correction bytes. No density or horizon increase. Actual
  per-view chunk counts vary with the camera, as intended. This does not establish
  presented FPS or GPU cost: previously omitted visible geometry now draws.
- Both 48-tree censuses, all52 dressing placements, exact camera restoration,
  original director resumption and owned browser/launcher/port shutdown pass.
  No page/GPU/cleanup errors. Study passes; overall remains FAILED on five
  missing-cow load errors and fourteen bronze-dagger missing-fit-metadata errors.
- Root checks 675 current source pins, 596 archives (59,144,201 bytes), all14
  PNG hashes and draw-list/owner/mask receipts in
  `grass-camera-root-verification01.json`. No source changes during capture.

## Direct visual result and next art work

All eight native art views were inspected. Grass blades now appear around the
northern trees in bank/anvil views and across the bay headland where the previous
camera state incorrectly culled them. Building cutaways still expose services;
outside building views retain their roofs. The corrected draw list does not make
the near preparation lawn look finished: that foreground remains notably bare,
uniform and visually disconnected from props.

The manifest's broad `preparation_campus_grade` already allows grass, but the
overlapping 36×36 m `central_haven_plaza` and its six-meter blend exclude it.
Investigate replacing broad natural-ground suppression with deliberate service,
building and path clearances before adding coherent soil/grass/understory layers.
Do not simply remove exclusions and let blades intersect stations or doorways.
The shader already has six packed1024 PBR maps; merely enlarging them will not
solve the composition. Shore transitions, ridge silhouettes and lighting/water
cohesion remain substantial work.

Older readiness/upload checks and scenic stills are not evidence of complete
correct-camera foliage coverage. This checkpoint corrects that gap; it still
does not qualify fast camera motion, edge/contact stability, full-frame CPU/GPU,
presented frames, memory/thermal/load budgets or the full betting/HLS experience.
No AAA or launch acceptance is claimed. The renderer test launches two controlled
agents without keeper, betting or streaming services.
