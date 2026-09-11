# Three.js r186 qualification — work in progress, integration failed

This is an implementation/verification record, not renderer promotion or launch
approval. The compact island still requires one arena and its real choppable
resource trees distributed across the world. No separate decorative forest is
being introduced. World composition, resource lifecycle, avatar/gear fit,
performance and actual stream acceptance remain open.

## Baseline and scope

Preserve probe17 and its executed sources. Its game runtime is
`c1933e898b64afa77a5b964200c90becfb7c7fd6`, asset revision
`fb41785c68c6324903559552a26af11da07c7143`; research/checklist HEAD before this
upgrade is `319f14edab8d6222fc3e3edad7fae5d70b868127`.

The candidate is Three.js `0.186.0`, three-vrm `3.5.5`, and postprocessing
`6.39.5`. Root overrides and nine relevant manifests are reconciled. The
postprocessing override includes transitive consumers that otherwise retain a
release excluding r186. Unrelated Forge dependency drift from lock generation
was restored to its previously locked revision; this is not a toolchain-wide
update.

Published Three declarations stop at `0.185.4` at this qualification. The
maintained, exact r186 declarations are packaged reproducibly over that published
baseline. See [provenance and reproduction](../patches/three-types-r186-provenance.md).
The `vendor/three-types-r186.tgz` archive is 362,202 bytes, SHA-256
`4ce38cd4af22a49a6317ebbdef3c713b52ff243b24c853c0b3cd71ec8070c27e`.
All 966 declarations, preserved metadata/license/README, and five published
forwarders have independent integrity assertions. This is not represented as a
published r186 npm release.

Bun 1.3.14's new-directory patch bug was reproduced in isolated fixtures with and
without Git index headers: the patch engine created non-searchable `0644`
directories. A normal local tarball override installs correctly, including a
clean isolated installation and frozen repeat. No global permissions were
changed; declarations remain ordinary `0644` files. The upstream investigation
is [Bun PR 33573](https://github.com/oven-sh/bun/pull/33573).

The existing root materialized r183 renderer survived the first normal install.
It was moved recoverably to
`/private/tmp/hyperia-renderer-install-repair.1JpJkH/three-root-0.183.2`;
normal Bun installation then restored the root link. Actual root, shared, client,
server, procgen, impostor, asset-forge, agent plugin, website and VRM peer
resolution now agree. Core/WebGPU Object3D, geometry/material constructors and
TSL uniform identity are checked; this does not by itself certify Vite's bundle
graph.

Install commands use the locked Bun 1.3.14 and Node 22.23.2, with
`--frozen-lockfile --ignore-scripts`. The Node policy was checked separately.
Skipping lifecycle scripts avoids unrelated full asset LFS hydration and browser
installation; it is not a claim that those lifecycle scripts were exercised.
WebGPU's already-locked `@webgpu/types@0.1.71` is now an explicit development
dependency/type inclusion rather than an accidental transitive global.

## Runtime migration

- Rebase the existing completed-pass/encoder lifetime patch onto exact r186
  source and both distributed WebGPU builds.
- Correct failed-initialization disposal: clear an existing animation callback
  without calling an initialization-capable public method during disposal.
  The application awaits disposal before its existing default-limit retry.
  This does not promise cleanup of arbitrary partially initialized backends.
- Select supported `PCFShadowMap` at all three active shadow configuration sites.
- Replace the removed post-processing constructor alias with public
  `RenderPipeline`; use official addon types and precise node-value signatures.
  Reconcile LUT dimensions, alpha, pass ownership and asynchronous LUT selection.
  Actual enabled-effect GPU/visual testing is still required.
- Reject an unsupported HDR texture type before allocation. Preserve the loader's
  actual floating-point output and existing image orientation.
- Use read-only typed node values for shader inputs, preserving mutable variable
  nodes where assignment is required. Project color uniforms through their RGB
  channels without changing color space or clamping HDR values. Texture-producing
  fields retain their actual four-channel node types.
- Admit finite, nonzero GLB splatmap UV scales, preserving negative scales and the
  existing zero fallback. Invalid untyped extras fall back to one before entering
  a uniform; the actual material conversion has an independent regression.

Final runtime patch SHA-256:
`582cc05d6f80e2f6b221ce05028ac8eb037907c4d98b6b59f32f19db6b60ad71`.

## Verification so far

| Check                                      | Result and scope                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Runtime/type archive/identity/color checks | 18 passed; exact installed bytes, class identity and live color channels                                  |
| Shared renderer/terrain/world regressions  | 994 passed across 56 files; includes post-processing and borrowed environment cases, not GPU/art approval |
| Server duel/preparation regressions        | 128 passed across nine files                                                                              |
| Actual GLB splatmap material conversion    | 11 passed; four independent channels and 12 real triplanar sample graphs, not GPU rendering               |
| Scoped formatting and lint                 | Final combined edited-code scope passed; the new splatmap test also passed the shared typecheck           |
| Shared, server and client typechecks       | All passed after resolving the initial 280 shared diagnostics; no new suppression                         |
| Fresh shared, server and client builds     | All passed; production bundle performance remains unqualified                                             |
| New actual-world probe18                   | Failed before capture on a transitive diagnostic helper's old revision guard; zero screenshots            |

Probe18 and its executed runner06/observer06/study12 bytes are preserved. Its
initial Vite dependency re-optimization produced eight 504 responses; subsequent
cache inspection resolves renderer entries to r186 and VRM 3.5.5, not proof of
browser constructor identity. The owned browser and services closed cleanly.
The probe19 successor pinned the complete diagnostic helper closure in a new
output directory; its subsequent delivery-assumption failure is recorded below.
The injected diagnostic equipment helper is not
evidence of production asset/CDN delivery.

The historical neutral-PMREM migration has a CPU mapping oracle: 45,342 actual
direction/mip samples agree within 9.095e-13 after per-face row reflection and
the required face swap; unconverted pixels disagree. The original atlas remains
unchanged. Actual r186 world appearance is still pending.

### Actual GPU lifecycle evidence

External immutable evidence directory:
`asset-studio/game-test-integration/renderer-r186-lifecycle04/`.
Its separately owned headful Chrome 152 process used sandboxing and no explicitly
enabled software renderer; the actual render device reported vendor `apple`,
architecture `metal-3`. This is not inferred merely from ANGLE's graphics string.

The live check passed:

- Never-initialized disposal requested no GPU canvas context or device.
- Native `requestDevice` rejected a limit of 16,385 against the actual 16,384
  maximum. Disposal retained the same failed promise, made no context request,
  and did not restart initialization. A new default renderer on the same canvas
  initialized and rendered correctly.
- Actual target rendering and public target-bound framebuffer copy read back
  `[255, 0, 0, 255]`.
- After a real viewport-texture draw, the retained real render context had null
  pass and encoder fields. A separately identified lower-level backend copy
  against that actual context read back linear `[1, 0, 0, 1]`.
- A warmed public compile executed the native viewport update/copy and returned
  the same linear pixel. Cold compile's legitimate skipped update was recorded,
  not counted as copy evidence.
- No unexpected page/GPU/rejection or cleanup errors; owned browser and HTTP
  server closed. This tiny regression is not a frame-time or world-art benchmark.

Earlier attempts remain intact. Attempt01 had an observer getter error. Attempt02
verified disposal/retry but exposed an unresolved native direct-canvas copy issue
with LinearSRGB/NoToneMapping and no intermediate target. Attempt03 incorrectly
expected a fresh node's update during cold compile. Attempt04 tests source-driven
production-configured paths and does not erase that direct-canvas limitation.

### Enabled post-processing GPU attempt01

The separately owned sandboxed Chrome process used an actual Apple Metal-3
WebGPU device. Identity-LUT synchronous and asynchronous draws matched within
the declared texture precision and preserved alpha. The later HDR assertion
failed with the exact earlier scene pixel hash, not a clamped HDR value: only
the fullscreen pass rendered, while the frame-scoped scene pass did not redraw
within that same animation frame. This attempt does not establish an HDR defect
or an effects pass. Its 85 source pins, four raw RGBA16F readbacks and failure
remain in `postprocessing-r186-gpu01/`; browser/server cleanup and source
integrity passed.

Attempt02 passed using the renderer's actual animation-loop chronology and a
real scene-render callback for each measured draw. All original numeric gates
were retained; no frame IDs were modified. Its 87 source pins and 14 raw image
readbacks remain in `postprocessing-r186-gpu02/`.

- HDR input red 1.4 returned 1.399414 in the half-float target.
- ACES/sRGB output agreed with a separate actual GPU reference within 0.000245.
- Blur changed 276 pixels; outline changed 476 pixels. Neither changed alpha.
  Disabling each restored its earlier sharp/unoutlined output exactly.
- Reusing the cached LUT made no second HTTP request. Composer disposal returned
  texture count from 15 to the caller's two baseline textures; repeat disposal
  and subsequent render calls produced no draw.
- Actual Apple Metal-3 device, no page/console/GPU/cleanup errors, unchanged
  source pins and owned browser/server/animation-loop cleanup all verified.

These are isolated 64x64 correctness checks, not visual art, representative
frame-time, production LUT delivery or actual stream acceptance.

Probe19 also stopped before captures: after successful external helper
installation, the old runner snapshot step still expected that diagnostic
bundle under the runtime asset directory. No runtime asset was created to hide
this mismatch. Preserve its 229 source pins, seven receipts and failure; the
next immutable probe20 must admit the already-pinned external bytes separately
from unchanged avatar/model/texture delivery.

## Actual-world probe20 — integration failed, preserve evidence

The owned session ran from 2026-09-11 00:48:32.154 UTC to 00:50:45.656 UTC.
All 234 source pins remained unchanged. The spatial study completed 11 camera
views and 22 PNGs, plus six baseline PNGs; its 45 retained art observations were
complete. Six exact textures (9,452,737 bytes) and five exact dressing models
(5,622,276 bytes) returned HTTP 200 and matched their prelaunch pins.

**Overall result: FAIL.** This is not a renderer promotion or merge checkpoint.

- 117 console errors: five known cow-loading errors, 14 known dagger fit-metadata
  errors, eight new TSL vec4 argument-length errors, and 90 new destroyed-texture
  GPU validation errors.
- The GPU errors comprise 45 reports for a 640x360 RGBA16Float texture in
  renderContext_3 and 45 for a 1280x720 RGBA16Float texture in renderContext_0.
  Their actual texture owners and first failing phase require investigation;
  ordered console strings do not provide event timestamps. Do not attribute them
  to teardown or waive them based on the spatial study passing.
- The pass/encoder observer itself recorded no violations (51,578 begins and
  matching ends). This does not prove texture lifetime correctness.
- No page exceptions. The owned browser, stack, database container and all four
  owned listening ports closed; cleanup operations and source integrity passed.

Matched visual review found no obvious armor deformation or missing outdoor
surface. The island-wide hospital slab is visibly free of the two green bands
seen in probe17, an image-specific improvement rather than a general shadow/depth
approval. Cyan night-lit skin remains in both versions. The world still has
oversized saturated foliage masses, a repetitive lawn, sparse pond dressing and
six arena pads. Only 12 sampled grass anchors were observed, none in the
preparation campus or pond-bank regions. Art, performance and resource-tree
distribution are not approved.

Preserved evidence under `asset-studio/game-test-integration/compact-world-probe20/`:

- `report.json`: SHA-256
  `9c48ba8318bc4a48b58bb962f235e83a70d3ad29f6bc3961d1868d60d6e9307e`.
- `spatial-study.json`: SHA-256
  `a9c8bc1b7b005d76d6658834750d95f044b053a2f178c1f5da1d8fc81723c60a`.
- `launcher.log`: SHA-256
  `0b54a24d35f7223a817b5e286b4456a9bfbfa9b239fe09471dff7fd4faabe633`.

The work is suitable for a clearly marked in-progress branch checkpoint, not
merging or deployment. The next renderer work must reproduce and resolve the
new shader/texture-lifetime failures before repeating whole-world qualification.

A primary-source lead for the texture investigation is
[Three issue 34301](https://github.com/mrdoob/three.js/issues/34301): its report
describes stale native texture views after same-size recreation. A maintainer
notes that setting `needsUpdate` on a render-target texture is unsupported.
The installed r186 descriptor cache warrants inspection, but similarity to this
issue is not proof of probe20's cause. Instrument native texture creation,
destruction, attachment/view identity and submission with timestamps before
changing engine lifetime behavior.

## Required next gates

Post-probe20 narrow shader correction: the maintained declaration labels
`materialColor` as RGB, but its actual mapped runtime setup produces RGBA.
Appending another alpha created a five-channel join. The pond material now uses
the exported `ConvertNode<"vec4">` with the same variable-intent wrapper as the
historical single-argument conversion. Five new real-material/node/WGSL
conversion tests and nine existing pond tests passed; shared typecheck/build
and scoped lint/format passed again. This preserves mapped alpha and promotes
mapless RGB with alpha one. It is CPU graph qualification, not proof that a new
world run is free of errors. Probe20 describes the prior bytes; the 90 GPU errors
remain separately unresolved.

- [x] Finish precise shader/type migration and shared/server/client typechecks and
      fresh builds. Existing unchecked legacy shader files are not certified by
      a passing typecheck.
- [x] Re-run final combined scoped lint, formatting and newly added tests.
      Production bundle/browser performance acceptance remains open.
- [x] Qualify historical neutral-PMREM coordinate mapping for r186 using an
      independent CPU oracle. Preserve original atlas/capture bytes; GPU visual
      acceptance remains open.
- [x] Run immutable probe20 on real Chrome/Metal and inspect the matched views.
      Its integration result failed; completing the capture is not passing it.
- [ ] Resolve the eight TSL construction errors and 90 destroyed-texture GPU
      errors with a reproduced cause, regression tests and fresh actual-world
      evidence. Preserve probe20 and its executed source bytes.
- [ ] Exercise enabled post-processing, HDR/IBL, animation, resource harvesting,
      actual stream encoding and representative performance/reconnect/teardown.
- [ ] Resolve or bound the recorded direct-canvas copy limitation explicitly.
- [ ] Save this scoped work-in-progress checkpoint, verify author/committer and
      exact remote revision. Do not merge or deploy the failed candidate.
- [ ] Continue one-arena authority and resource-tree distribution work, including
      stable IDs, snapped grounding, tile-unload boundaries, depletion/respawn,
      navigation and actual spectator presentation.
