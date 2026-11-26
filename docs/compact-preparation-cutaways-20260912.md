# Compact preparation-view cutaways — 2026-09-12

## Scope and verdict

The unchanged bank and anvil diagnostic cameras now reveal their services and
agents. Previously, the lodge roof filled much of the bank foreground and the
smithy's high ring beams crossed the anvil and characters after its roof faded.
This is a verified intermediate readability correction, not finished island art,
moving-camera, frame-time, streaming, gameplay or launch acceptance.

## Implementation and physical invariants

The smithy's four high ring beams now use the existing upper-structure label.
All four posts and eight short braces remain visible. No vertices, indices, UVs,
normals, materials, station positions, collision tiles or terrain are changed.
Regression hashes recorded from the pre-change built recipe verify every geometry
attribute except the intentional visibility label, plus the indices, for all
three smithy batches. The failing old-beam assertion is preserved in the evidence.

The lodge uses its actual local roof bounds and prepared inverse root transform,
including its existing rotation. The bank camera looks outward from within its
eaves, so a center-target ray alone cannot detect its foreground roof intrusion.
The roof envelope supplies a bounded proximity cutaway with hysteresis. Only the
roof and upper gable/trim band fade; lower walls, windows and doorway remain.
The height threshold includes the admitted recipe's 0.18 m verge/eave trim.

Both structures use the same existing 220 ms bounded Bayer fade with opaque
endpoints. No transparency sorting, extra render pass, mesh, texture or distance
quality reduction is added. The lodge retains five meshes, four materials, 1,332
triangles and 168,376 geometry bytes; smithy remains three meshes/materials, 824
triangles and 136,968 bytes. These counts are not timing measurements.

Camera-specific values are applied per draw. Other camera passes receive the
complete structure; returning to the main camera in the same renderer frame
restores its fade without advancing the clock twice. Pointer raycasts ignore only
fully hidden upper surfaces. Original mesh raycasts and authoritative collision
surfaces remain intact. Explicit full shadow masks are retained independently.
Three.js documents separate [visible and shadow material masks](https://threejs.org/docs/pages/NodeMaterial.html).
No paired shadow-atlas pixel comparison or moving-edge approval is claimed here.

## Verification

Evidence prefixes below are relative to the parent workspace's
`asset-studio/compact-smithy-court01/`.

- `roof-tests-before01.json`: 17 pass, one intentional ring-beam failure against
  the old built procgen recipe. Physical-byte hash checks already passed.
- Rebuilt procgen, then `roof-tests02.json`: 18/18 focused checks, including exact
  native cameras, prepared matrices, parent-camera transforms, rotated roof bounds,
  hysteresis, nearby/interior/far/high/below-floor cases, retained physical hits,
  main/other/main pass isolation, invalid frame values and ownership/disposal.
- `roof-shared-tests03.json`: 1,155/1,155 across 84 real-system test files, two
  workers. Includes native PhysX/collision and resource/navigation regressions.
  The previously recorded intermittent grass-publication issue remains open;
  this passing run does not establish its cause or remove it from the checklist.
- `roof-procgen-build01.log`, `roof-types-{shared,client,server}01.log`,
  `roof-build-{shared,client,server}01.log`: successful builds/type checks.
  Scoped ESLint, Prettier and diff checks pass.
- `roof-preflight02.log`: all six source/content/capture preflights pass. The
  original startup, renderer, content-error and cleanup gates remain intact.
- Native `roof-cutaway-probe01` stopped after the first art capture: the canvas
  acquired `cursor: default` during the exact DOM-restoration check. Installation
  had hidden the HUD correctly; restoration correctly rejected the changed inline
  canvas style. Missing-image and launcher-exit cleanup gates also failed. The
  browser closed, all four ports were free and a separate process check found no
  surviving owned launcher. This failed report and its original sources remain.
- Probe02 first enters and leaves the actual canvas with the mouse, initializing
  the application's existing mouse-leave state. No canvas CSS is written by the
  harness and no DOM-restoration assertion is relaxed. The pointer stays outside
  the canvas; no click or game-input override is used.
- Native `roof-cutaway-probe02`: all eight art views plus six baseline PNGs on
  headful nonfallback Metal WebGPU, 1280×720, DPR1, MSAA4. Eight art views directly
  inspected by the root agent. Bank/anvil endpoints hide their upper structure;
  distant and outside views retain complete buildings. Actual owner/mask receipts
  match at screenshot boundaries; no model, tree or terrain replacement occurs.
- Study passes, page/GPU/cleanup errors zero. Exact atomic camera restoration,
  original director resumption, owned Chrome/launcher shutdown and free ports pass.
  The overall report still fails: five missing-cow load errors and fourteen
  bronze-dagger missing-fit-metadata errors. These are not suppressed or accepted.
- Root independently verifies 675 current source pins, 596 archives (59,138,031
  bytes), all 14 PNG hashes, camera/owner/mask receipts and shared vegetation
  geometry/material/map identities: `roof-root-verification02.json`.
- Report: `asset-studio/game-test-integration/roof-cutaway-probe02/report.json`;
  SHA-256 `65f3c60ca398de3bb4f3f1483d3faa1e72a023d4212b0746cfc98ffbe5f9f17d`.

## Visual assessment and remaining work

The bank's large foreground roof wedge is gone, exposing the bank chest, path
intersection and pond. A small lower-wall edge remains at the left as intended.
At the anvil, the obstructing ring beams are gone and the anvil/agents are readable;
the retained posts/braces and roof shadow keep the structure spatially apparent.
The smithy-front/west, meadow and campus views retain complete roofs and eaves.

The broader island is still far below the requested finished presentation: large
uniform lawn areas, overly isolated props, visibly synthetic ridge shapes, abrupt
shore transitions and repetitive planting remain. The next art pass should address
coherent ground/plant layering around real functional trees and services, then
shore/rock composition and unified lighting/water. Do not call this AAA because
the geometry and screenshot contracts passed.

Moving-camera fades, shadow/edge behavior, animation, real full-frame CPU/GPU
cost, presented frames, memory, target-hardware population and stream/endurance
qualification are open. This two-agent diagnostic does not run keeper, betting
or HLS. Current Three.js [SSGI](https://threejs.org/docs/pages/SSGINode.html) and
[temporal antialiasing](https://threejs.org/docs/pages/TRAANode.html) remain options
to measure, not automatic defaults: temporal artifacts and velocity/MSAA contracts
must be validated against actual moving characters, foliage and water.
