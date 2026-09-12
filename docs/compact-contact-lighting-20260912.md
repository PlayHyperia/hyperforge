# Compact contact lighting experiment — 2026-09-12

Status: **explicit experiment only; not enabled by any graphics profile and not
visually or performance qualified**. The normal client entry point exports
`CompactContactAO`; construction/rendering still requires an explicit caller.
No renderer default, world material, asset, lighting setting, camera controller,
water setting, clock, avatar body or equipment transform changes in this slice.

## Implemented and verified

The r186 pipeline owns a full-pixel normal/depth prepass, GTAO, optional
materialized denoise, four-sample HalfFloat beauty pass and one output color
transform. AO can be compared at full or half resolution; neither selection
changes the canvas, DPR or beauty antialiasing. The geometry buffer is
single-sample because GTAO's depth gather cannot sample a multisampled depth
attachment. This is a separate buffer contract, not a four-sample normal claim.

The prepass borrows actual materials and their skin/wind/cutout nodes. It does
not substitute an override material. Ordinary materials are admitted through the
actual renderer's node library. Depth/color-disabled, transmissive and blended
surfaces are excluded explicitly. Group counts distinguish admitted skins from
excluded skins; diagnostic rows are capped at 32. Unsupported custom fragment/MRT
paths fail. Public render state is restored, owned targets are disposed
idempotently, and a failed native session cannot be reused.

All runtime nodes now come from the public Three.js module graph. Deep-source
PassNode/RTTNode imports produced a separate Node identity/cache universe even
with only one installed package version. The live experiment also found a real
MeshLambertMaterial absent from the original support whitelist. Both issues have
regression coverage. CPU tests cannot establish successful GPU compilation.

Validation: 12 focused tests; 1,149 shared regression tests across 84 files,
including real terrain workers/native physics where applicable; scoped
zero-warning lint/format; shared/client/server type checks and production builds
(the client build also rebuilt shared with declaration generation). These counts
are not whole-project, visual, motion or performance approval.

## Retained native attempts

All attempts used the actual local world in headful Chrome with nonfallback
WebGPU, 1280×720, DPR1, unchanged four-sample final-image antialiasing. They retain
the two-agent maintenance setup; they do not run the keeper, betting transaction
or HLS pipeline. Earlier failed reports and executed source archives remain
immutable.

| Attempt | Actual result |
| --- | --- |
| 01 | Raw TypeScript module delivery rejected with HTTP403; no AO rendering. Fixed by using the normal compiled client entry point. |
| 02 | Compiled delivery succeeded; actual Lambert material rejected. Also two page errors and 21 GPU errors with malformed generated WGSL. Public node identities and actual material-library admission corrected. |
| 03 | Depth textureGather rejected multisampled input: 18 GPU errors. Terminal experiment now stops the owned render loop; actual unequip acknowledgement timed out after that stop. Browser/launcher/ports still shut down. |
| 04 | Single-sample geometry buffer rendered without page/GPU errors. Overly broad per-camera skin assertion stopped at the anvil: no admitted skin groups. The failed attempt is retained. |
| 05 | All 18 AO-study captures plus six baseline images completed. Graph/coverage/camera/cleanup checks pass, but image parity and performance remain unqualified. Overall run is still false for 19 existing cow/dagger content errors. |

Probe05 has zero page/GPU/cleanup errors. Root independently verified all 673
current source pins, 596 executed source archives (59,132,588 bytes), 24 PNG
hashes/dimensions, exact camera/render-hook restoration and owned browser,
launcher and port cleanup. The remaining 77 pins are hashed, not claimed as
archived files. Source identity is evidence for this checkpoint, not future
modified files.

The meadow prepass records 58 admitted skin groups at both resolutions. Service
views instead record excluded depth-write-disabled skin groups. This proves
the observed draw-path coverage only: it does not identify every visible avatar
pixel, approve a material's transparency policy or establish motion correctness.

## Visual verdict: do not promote

Root inspected direct, neutral and active anvil images, the active bank and
meadow, and the direct-after control. The furnace is dark in both direct images
and noticeably blue-gray through the neutral/active graph. That is a parity
warning, not an approved recolor or demonstrated cause. Do not compensate by
changing its texture or exposure.

Six neutral-to-active AO pairs meet the unchanged 0.01 daylight-phase tolerance.
All three direct-to-neutral and three direct-before/after pairs miss it:
direct-to-neutral differences are 0.01325–0.01652; direct bookends
0.03178–0.03874. These are not matched controls and are explicitly retained as
failures of pairing, independent of graph execution success. The next comparison
must prewarm the actually selected modes and obtain valid direct/neutral pairs.
If the material difference remains, isolate its direct/beauty shader, environment,
shadow and color-transform paths before integrating AO.

AO does not fix the roof obstructing the bank camera, smithy beams across agents,
uniform lawn, sparse ground cover, abrupt shoreline or weak island silhouette.
Those art tasks remain required. No AAA verdict, new default, reflection support,
temporal stability, presented FPS, isolated GPU time, total GPU memory,
streaming/endurance or launch approval is granted.

## Next acceptance work

- [ ] Establish valid direct/neutral controls and diagnose the furnace/other
      material differences. Verify color/alpha, grass and cutout edges, animated
      skin/armor, water and shadows with pixel and moving-camera evidence.
- [ ] Measure the entire added GPU workload by game frame, including all geometry,
      AO, denoise, beauty and output passes. r186's timestamp resolver can return
      the last internal render-frame duration; do not label that final quad as
      total game-frame GPU cost. Keep screenshot-heavy reviews performance-ineligible.
- [ ] Compare full/half AO visually and temporally before selecting any production
      quality setting. Preserve resolution/DPR and declare all buffer costs.
- [ ] Continue island art: planted service edges around functional resource trees,
      worn-ground variation, recovery access/perimeters and richer shore/rock
      composition. Keep navigation, tree approaches, collision and batching intact.
- [ ] Resolve cow-model404/dagger metadata and qualify real multi-agent
      preparation/combat/streaming, lifecycle and sustained target-hardware load.

## Research and version decision

The installed r186 already provides GTAO and the indirect-light integration
used here. Temporal filtering has ghosting/instability tradeoffs and requires
TRAA, so it is not switched on merely to hide noise.
[Official GTAONode guidance](https://threejs.org/docs/pages/GTAONode.html).

The geometry buffer separation follows actual native errors and WGSL's allowed
depth-gather overloads, not a WebGL workaround.
[WGSL textureGather](https://www.w3.org/TR/WGSL/#texturegather).

SSGI offers bounced lighting, but its per-pixel slice/step cost and temporal
requirements need a separate measured experiment; adding it now would confound
the unresolved neutral baseline.
[Official SSGINode guidance](https://threejs.org/docs/pages/SSGINode.html).

Repeated scene dressing should continue to share geometry/materials and use
instancing/batching with visibility bounds. Batching reduces submission overhead,
not all shading or overdraw costs.
[Official BatchedMesh guidance](https://threejs.org/docs/pages/BatchedMesh.html).

## Evidence

External workspace evidence is under
`asset-studio/game-test-integration/contact-ao01/` and
`contact-ao-probe01/` through `contact-ao-probe05/`.
`verify-native-root.mjs` and `root-verification02.json`–`05.json`
retain independent checks, including failed runs. Focused test reports:
`cpu-tests05.json`, `shared-tests06.json`.

Probe05 report SHA-256:
`e3d6fc1b8263fd827c421b89cf53eae3259cf076b7f598b7b1e913db25dd6c6d`.
The external harness and local model/texture delivery are not a newly packaged
production release.
