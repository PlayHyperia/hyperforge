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

Original migration runtime patch SHA-256 (superseded by the viewport fix below):
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

## Probe21: native texture cause narrowed, pond shader fix verified

The actual Chrome/Metal run completed 2026-09-11T01:22:25.479Z through
01:24:41.288Z. All 245 source pins remained unchanged, all 11 spatial views
completed, and the eight TSL errors are now absent. The 90 GPU errors remain;
19 other console errors are the retained cow-loading and dagger-content failures.
Report SHA-256:
`61279968ab7d3a1acf8b21e7070858a752d15bf44c6dfaec9582095954e4f58f`.

The native trace finds 90 destroyed-resource submissions across 58 native texture
generations belonging to two `FramebufferTexture` UUIDs (640x360 and 1280x720).
These are bound texture views, not stale render-target attachments. Every retained
first failure has matching UUID/version and ordered upload-flag, destruction and
submission evidence. `ViewportTextureNode.updateBefore` bumps the version;
`Textures.updateTexture` destroys the previous allocation during a framebuffer
copy. All observed failures occur in the spatial study, before cleanup, with
`preCompiling=false`. The earlier same-size render-target issue is not this
demonstrated cause.

Actual pre-edit r186 classes reproduce shared mutable source/image metadata
between the distinct viewport-reference textures. Alternating reference dimensions
overwrites the other copy's dimensions. Preserved r183 classes reproduce the same
aliasing, so this is not claimed to be a newly introduced r186 source defect.
Ordinary asset textures intentionally share their sources; the fix is restricted
to copied viewport-reference dimension ownership.

The durable Three patch now gives each viewport-reference clone a fresh
`TextureSource` with copied image metadata. Existing texture settings, cache reuse,
ordinary asset sharing and the previous renderer lifecycle fixes are retained.
Patch SHA-256:
`1f1cea27b53a11cc4f195c5e10772b0855f711506b0845395392b4e5792d3df6`.
Root's pre-edit ownership assertion failed as expected; 15 new actual-class
regressions across source and both bundles pass after the fix. Combined identity,
declaration, patch and ownership tests: 33 passed. Shared/server/client builds and
scoped test lint/format pass. Frozen installation also exposed Bun's prepared root
copy as a duplicate renderer; preserving it outside the workspace and restoring
normal package links resolved that check. No unrelated source or lock changes
were needed. Fresh actual-world post-fix qualification remains required.

The trace is diagnostic, not a performance result or comprehensive GPU lifetime
proof: 10,748 unknown descriptors and 18,586 render-bundle sampling calls remain
explicitly untracked alongside compute/external sampling. No tracking-cap overflow,
reference drops, metadata errors or restoration errors occurred. All native
wrappers and the actual Node stack-capture flag were restored.

Overall cleanup still FAILED: the launcher reported a game-client process-group
inspection `EPERM` during shutdown. Later OS metadata showed its owned leader as
a zombie before the exit event. Closed browser, exited PostgreSQL and empty four
owned ports do not waive that failure. The retained launcher log preserves the
bounded diagnostics; this separate lifecycle gate remains open.

## Post-fix probe24 — reproduced GPU failures cleared, integration still failed

Preserve post-fix probes22/23: both stopped before rendering when the application's
native adapter request timed out after 30 seconds. They allocated no traced native
textures, so neither qualifies the viewport patch. Independent actual headful
Chrome/Metal checks with sequential and concurrent native adapter requests passed.
No source-proven startup cause or driver defect was established.

Probe24 adds bounded, first-in-document native adapter-call timing without changing
arguments, receiver, returned Promise, application timeouts, GPU flags or render
settings. It ran 2026-09-11T01:45:58.559Z through 01:48:16.772Z. One document
navigation and three successful native requests were observed: diagnostic default
133.2 ms, application high-performance 130.7 ms, backend high-performance 4.4 ms.
All were visible/focused; no pending calls, dropped events or restoration errors.
This success does not resolve the earlier intermittent startup failures.

The actual Apple Metal-3 world completed the unchanged 11-view/22-PNG spatial
route and six baseline PNGs at 1280x720/DPR 1. All 258 pins remained unchanged;
six terrain textures and five dressing GLBs returned exact matching HTTP 200
bytes. Report SHA-256:
`280b3d606d06afd0516d0fc24d7dfa39222a244fec1028c37cb04a8ee4a43dbf`.

- Zero TSL construction errors, GPU validation errors or page exceptions.
- Zero traced destroyed-reference submissions, compared with 90 in probe21.
  Before cleanup: 17,250 native submits, 349 texture creations, two destructions
  and 21 target upload flags. The bounded trace still excludes render-bundle,
  compute and external-texture sampling; it is not comprehensive GPU proof.
- All owned camera, equipment, Node and native descriptor cleanup passed.
  Browser closed, launcher exited zero, owned database exited and all four owned
  listening ports were empty. Probe21's separate shutdown failure stays recorded.
- Overall integration **FAIL**: five cow-loading errors (missing cow VRM) and
  14 canonical bronze-dagger fit-metadata errors remain. Source hashes and
  successful diagnostic equipment injection do not certify production delivery.

This qualifies the narrow viewport-reference fix against the reproduced actual
world failure. It is not art, performance, sustained startup, stream, merge or
launch approval. Night-lit skin remains cyan against neutral-lit metal; trees
remain oversized/saturated and the island repetitive with six visible arena pads.
The loading overlay also covers the baseline kit views; separately labeled
under-overlay captures are diagnostic, not normal spectator output approval.

## Additional lifecycle findings — not probe20 causal conclusions

Read-only comparison of actual r186 against the preserved r183 package found
no same-size `RenderTarget.setSize()` disposal regression. Reflector camera and
target caching remain effectively unchanged. The five application precompile
producers are avatars, equipment, representative terrain and grass meshes, and
countdown sprites; none explicitly compiles water or the full scene.

Two separate follow-up risks must remain in the launch checklist:

- `ClientGraphics.ts:445–462` races a compile against a timeout without cancelling
  or awaiting the underlying work afterward. Its serialized queue can advance
  while the timed-out compile is still active. Probe20 has no retained precompile
  timeout error, so this is not its demonstrated cause.
- `WaterSystem.ts:1770–1773` checks `reflection.renderTarget`, whereas the actual
  Three node owns its targets through `reflection.reflector.renderTargets`.
  Correct disposal must follow the actual node ownership and be tested for
  restart/reconnect; this is a teardown leak, not proof of active-render failure.

## Required next gates

Post-probe20 narrow shader correction: the maintained declaration labels
`materialColor` as RGB, but its actual mapped runtime setup produces RGBA.
Appending another alpha created a five-channel join. The pond material now uses
the exported `ConvertNode<"vec4">` with the same variable-intent wrapper as the
historical single-argument conversion. Five new real-material/node/WGSL
conversion tests and nine existing pond tests passed; shared typecheck/build
and scoped lint/format passed again. This preserves mapped alpha and promotes
mapless RGB with alpha one. Probes21/24 additionally verify no TSL errors in the
actual world. Probe24 clears the reproduced 90 GPU failures with the viewport
ownership patch; broader integration and startup reliability remain open.

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
- [x] Resolve the eight TSL construction errors and reproduced 90 destroyed-texture
      GPU errors with regression tests and actual-world probe24 evidence.
      Preserve probes20–24 and all executed source bytes.
- [ ] Resolve intermittent application adapter admission timeouts and remaining
      cow/dagger production-content errors; qualify ordinary spectator loading.
- [ ] Exercise enabled post-processing, HDR/IBL, animation, resource harvesting,
      actual stream encoding and representative performance/reconnect/teardown.
- [ ] Resolve or bound the recorded direct-canvas copy limitation explicitly.
- [x] Save and push scoped work-in-progress code checkpoint
      `eb2270cc7821bada884a85944f2f2ab3b5a20ad2`. The exact remote revision and
      GitHub author/committer `dreaminglucid` were verified. Do not merge or
      deploy the failed candidate.
- [ ] Continue one-arena authority and resource-tree distribution work, including
      stable IDs, snapped grounding, tile-unload boundaries, depletion/respawn,
      navigation and actual spectator presentation.
