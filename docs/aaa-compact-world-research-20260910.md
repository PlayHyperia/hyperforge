# Hyperia compact-world audiovisual production plan

## Direction

The target is a compact, coherent, high-quality agent island with one duel arena.
Its trees are the existing choppable resource trees, naturally distributed across
the island and fully connected to gathering, depletion and regrowth. There is no
separate decorative forest and no requirement to retain the retired large island.
Lighting, terrain, equipment, motion and sound must work as one experience while
preserving bounded updates, shared assets and measurable performance.

The most valuable next work is not a blanket package upgrade or asset-pack drop.
It is a controlled renderer qualification followed by a finished spatial and
audiovisual slice: resource groves, pond, preparation village and a single arena.
The existing source and visual evidence establish a development baseline, not
AAA quality or production readiness.

## Research and implementation briefs

These detailed reports separate inspected local behavior from published evidence,
recommendations, proposed budgets and unverified assumptions. Each includes its
own primary-source inventory and version applicability. Together they form the
implementation reference; the launch checklist remains the authority for task
status, not an assertion that research recommendations are already implemented.

| Brief                                                                                | Scope and immediate value                                                                                                                                              |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Terrain, resource trees and assets](research/terrain-vegetation-assets-20260910.md) | Landscape composition, actual resource-tree authority, redistribution hazards, grass coverage, material continuity, instancing/LOD, texture compression and provenance |
| [Lighting, sky and water](research/lighting-sky-water-20260910.md)                   | Shared material response, environment illumination, visible sky, fitted shadows, water optics and bounded reflection cost                                              |
| [Animation, audio and streaming](research/animation-audio-stream-20260910.md)        | Canonical rig/equipment contracts, turns and foot contact, action-event timing, soundscape and decoded broadcast A/V verification                                      |
| [Renderer dependency qualification](renderer-dependency-audit-20260910.md)           | Actual installed versus stable versions, retained local patch, migration hazards, private diagnostic compatibility and controlled A/B promotion                        |
| [One-arena composition scope](single-arena-world-composition-plan-20260910.md)       | Authoritative arena removal, admission/reservation behavior, compact layout, resource routes and scene acceptance                                                      |

## Ordered work and acceptance

1. **Renderer baseline and upgrade qualification.** Preserve the current build
   and isolate the Three/VRM migration. Rebase the render-pass safety patch,
   migrate shadow selection and version the private diagnostics. Test the actual
   hospital-depth scenario, materials, avatars, lifecycle and performance before
   adopting new illumination defaults. A newer version is not proof of a fix.
2. **One arena and a functional landscape.** Remove surplus arena authority and
   collision together. Compose the preparation village and routes, then spread
   the existing choppable resource trees using their real entity/instancer path.
   Prove tile ownership, post-snap grounding, persistent identity, harvesting
   approaches and complete deplete/respawn behavior before increasing coverage.
3. **Lighting and material agreement.** Establish fixed neutral and outdoor
   reference views for skin, armor, vegetation and terrain. Reconcile visible sky
   with actual environment illumination, align sun/exposure and fit shadows to
   useful space. Do not compensate for lighting defects by recoloring every asset.
4. **Coherent surface and foliage art.** Finish landforms, shoreline, ground
   materials and contact; use resource-tree groves to frame activity. Add bounded
   grass/understory where cameras can see it, retaining water/path/floor exclusions.
   Inspect foliage silhouettes, temporal shimmer and actual stream compression.
5. **Integrated movement and sound.** Qualify the canonical rig and modular gear
   across diagonal travel, smooth facing, combat-style changes, tools and bow use.
   Tie animation and audio cues to authoritative action timing with deduplication;
   verify preparation ambience, combat clarity, mute/volume preferences and mix.
6. **Whole-experience proof.** Test preparation-to-duel transitions, contention,
   reconnect/restart, actual streaming, frame-time tails, loading and memory.
   Inspect decoded audio/video continuity, not only a successful encoder process.
   Maintain the separate SOL safety and real-money launch gates.

Each step requires an identifiable source/asset revision, proportionate automated
regressions, actual WebGPU views or motion evidence, explicit remaining defects
and measured costs where relevant. Preserve the same resolution, DPR and quality
between comparisons. Proposed triangle, texture, frame and population budgets
in the reports are experiments to qualify, not certified hardware limits.

## r186 high-end graphics research addendum

The goal is the best achievable cohesive image **and** smooth, scalable operation
on the compact island with one arena. Its canopy remains functional resource
trees, including harvesting, depletion and regrowth. The capabilities below are
available in Three.js r186; their presence does not mean they are integrated,
performant in this game, visually approved or evidence of AAA quality. This
addendum changes no runtime settings or approved quality targets.

1. **Calibrate lighting and materials together.** Establish a coherent sun,
   visible sky, environment illumination, exposure and water-reflection condition
   before adding effects. Review skin, metal, stone, ground and foliage under
   that same condition. The
   [official r186 ocean example](https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/webgpu_ocean.html)
   combines WebGPU SkyMesh, WaterMesh, PMREM and RenderPipeline. These are usable
   building blocks, not a reason to replace working game systems or regenerate
   environment lighting every frame.
2. **Author the landscape at three scales.** Prioritize island and grove
   silhouettes, readable preparation routes and ground regions, then close-up
   normals, roughness and restrained understory. Preserve authoritative terrain
   and rendered grounding rather than introducing visual-only displacement.
   Reuse existing resource-tree and grass instancing/LOD paths. Instancing reduces
   draw calls; it does not eliminate triangle, foliage-overdraw or shadow costs.
   [Three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)
   also requires bounds to remain correct when instances change.
3. **Improve shadow and contact quality where activity occurs.** Compare the
   existing bounded shadows with a small, tightly fitted cascade configuration
   only where moving cameras benefit. Each cascade has its own shadow-casting
   light and associated work; do not increase coverage or resolution blindly.
   [CSMShadowNode](https://threejs.org/docs/pages/CSMShadowNode.html) is the
   WebGPU-specific implementation. Trial restrained
   [GTAO](https://threejs.org/docs/pages/GTAONode.html) for contact, initially
   evaluating its documented half-resolution option against full resolution.
   Reject dark halos, foliage artifacts and loss of combat readability.
4. **Deliver texture detail within measured residency budgets.** Evaluate
   [KTX2/Basis loading](https://threejs.org/docs/pages/KTX2Loader.html) on the actual
   renderer, which selects supported GPU compression. Compare alpha silhouettes,
   normals and roughness before promotion. Record GPU allocation and mipmaps,
   not merely download size; a small compressed image file is not proof of a
   small resident texture. Preserve material color-space and ownership contracts.
5. **Qualify antialiasing in motion.** Compare the existing AA path with
   [r186 TRAA](https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/webgpu_postprocessing_traa.html),
   whose example uses color, depth and velocity buffers. Test actual skinned
   avatars, weapons, wind deformation, camera cuts and LOD changes for shimmer
   and trails. GTAO temporal filtering likewise depends on TRAA and can introduce
   ghosting. A still image cannot approve either temporal effect.
6. **Add expensive atmosphere and indirect lighting selectively.** Keep calm
   pond optics distinct from the ocean and count planar reflection as additional
   rendering work. Trial localized atmosphere only after the base image works:
   the [r186 volumetric-lighting example](https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/webgpu_volume_lighting.html)
   uses 12 raymarch steps at quarter width/height plus blur. This is a cost-aware
   example, not a free full-world atmosphere solution.
   [SSGI](https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/jsm/tsl/display/SSGINode.js)
   is available with explicit sample-count and temporal-artifact tradeoffs;
   screen-space illumination is not complete world-space GI. Both remain
   optional experiments until visual improvement and sustained cost are proven.

### Qualification and hardware boundary

The current development machine is an Apple M5 with 10 GPU cores; deployment
hardware and minimum supported client hardware remain unqualified. Freeze an
explicit resolution, DPR, frame-rate target, quality profile, launch population,
camera route and encoding workload for each comparison. Do not silently lower
quality, population or resolution to obtain a passing result, and do not promote
a development-machine result to a deployment guarantee.

Require clean actual WebGPU execution, preserved gameplay/grounding contracts,
reviewed stills **and motion**, decoded-stream inspection, cold/warm loading,
CPU/GPU frame-time distributions, stalls, memory residency and sustained thermal
behavior. Recheck camera changes, resource turnover and teardown. Optional GPU
formats and timestamps require checks against the actual device's
[WebGPU features](https://gpuweb.github.io/gpuweb/); API availability does not
establish a performance budget. Chrome's
[developer-only timing features](https://developer.chrome.com/docs/web-platform/webgpu/developer-features)
must not become production requirements. Retain failed evidence and separate
instrumented correctness captures from representative performance runs.

## Current implementation and evidence limits — 2026-09-11

The current uncommitted candidate adds an explicit v3 headland/inlet shape,
warmer meadow and shared stone campus surfaces. Actual contact probe39 reduced
the root mismatch from90mm to20mm and exposed occupied-spawn relocation still
using the old support path; that path is now corrected but awaits recapture.
See [landscape and grounding qualification](compact-landscape-grounding-20260911.md).

Current pushed follow-up: game84a18a123 and assets e26cc737 preserve five-tree authored redistribution and actual
daylight sole/floor measurements pass their evidence gates in probes37/38, while
both whole runs retain inherited content failures. The physical 9cm player-root
disagreement and large-scale island composition remain defects. See
[grove/contact qualification](authored-grove-contact-qualification-20260911.md).

An earlier pushed game checkpoint is
`426cb8039deab0e96848dcab7b32ff3a91687061`, including resource lifetime checkpoint
`72621c1bc871473faee161ae56faff843f1f2ee3`; assets remain
`d6f52841f5d9173247e4499902ba1c27f96c2a89`. Probe34's focused daylight study and
probe35's complete spatial study pass, but both whole runs retain cow/dagger
content failures. Their reviewed pixels remain below the intended art standard:
detached-looking character shadows, weak armor/material depth, uniform sparse
lawn and crowded resource crowns. See [exact evidence and remaining gates](resource-grove-prerequisites-20260911.md).

The preceding paired presentation checkpoints were game
`621f6e94a7da83b298c085ca0d1e48d88c1a9bee` and assets
`d6f52841f5d9173247e4499902ba1c27f96c2a89`. There is now one authoritative
arena, a smaller campus grade, native compact-tree lighting and corrected
resource transform handling. Probe30 has 28 reviewed images, no recorded
GPU/page errors and clean owned cleanup, but the complete run still fails
inherited cow/dagger content errors. The image remains below the intended art
standard; this is not a release qualification. See
[compact presentation evidence](compact-presentation-qualification-20260911.md).

Subsequent checkpoint `9c004c2ad82dc5291c385cfada73c1e614e09145` added the explicit sunlight-shadow profile with startup
preference ownership and actual configuration receipts. Fresh package builds,
typechecks and 239 focused tests pass after correcting the browser export boundary
and embedded-route scope. Probes31–33 retained actual WebGPU evidence; visual
approval and representative performance remain open. See [shadow qualification](shadow-stream-profile-qualification-20260911.md).
No optional effect is promoted by this research document. Heavy diagnostic
captures must not be presented as representative frame-time benchmarks.

### Follow-up: contact before effects, stable coverage before more maps

The current single4096² map spans400m, or9.77cm per texel. Actual r186 shadow
coordinates also expose roughly11.99cm of light-depth-equivalent bias at the
current near/far0.5/600 and bias0.0002; that is not a measured vertical foot gap.
Probe34 instead confirms two actor roots differing by9cm over one flat lobby
floor. Actual deformed sole measurements are needed before either root placement
or shadow bias is corrected; stale copied-logic grounding tests are not runtime
evidence.

The next shadow experiment should retain one map, qualify tighter useful coverage
and snap its centre in light space. Avoid continuously changing the projection
scale: conservative quantized spans and grow-immediately/shrink-on-cut hysteresis
are a candidate, not yet implemented. Include off-camera casters whose projected
shadows enter the view; current tree `setVisibleAt(false)` culling can remove them.
Do not duplicate decorative trees or silently shrink shadow distance to make a
small image look sharper. Fitting and stabilization are established approaches;
see [Microsoft shadow-map guidance](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/common-techniques-to-improve-shadow-depth-maps).

CSM remains a separate option, not a toggle-ready fix: each cascade owns another
shadow-casting light, and camera changes require updated frustums. Locally,
terrain currently disables shadow receiving when CSM is enabled, so that
incompatibility must be solved and measured first. [Three CSM documentation](https://threejs.org/docs/pages/CSMShadowNode.html).

Later contact-AO trials should compare small-radius half-resolution GTAO with
full resolution and include its depth/normal and denoising cost. More samples
increase work; temporal filtering requires TRAA and can introduce ghosting.
AO cannot repair physically floating feet or missing directional casters.
[Three GTAO documentation](https://threejs.org/docs/pages/GTAONode.html).

## Historical pond checkpoint

The preceding pond runtime checkpoint was game
`c1933e898b64afa77a5b964200c90becfb7c7fd6` paired with assets
`fb41785c68c6324903559552a26af11da07c7143`. Both exact branch refs and GitHub
author/committer `dreaminglucid` are verified. The source checkpoint retains all
179 probe17 source/art pins after the normal commit hook. No dependency update,
tree redistribution or single-arena runtime change is included in that checkpoint.

Probe17 shows a narrower wet bank and restored plant visibility, but the pond
remains bowl-like, the campus is sparse and six arena pads remain visible.
The complete run still fails cow404 and canonical dagger metadata errors.
Hospital striping, avatar/equipment appearance, actual stream approval and
representative CPU/GPU/thermal performance remain open. Full receipts and limits
are in [the pond checkpoint](compact-pond-bank-checkpoint-20260910.md).

The three detailed research reports are preserved byte-for-byte from their
reviewed snapshots. Local links identify evidence available in the development
workspace; large capture archives, editable Blender sources and original download
receipts are not made portable merely by committing these Markdown files.

| Report                        | SHA-256                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| Terrain/resource trees/assets | 263df682308567c890e8291101f01deae317e7fbad44d297905ec4099acb844b |
| Lighting/sky/water            | efc4ffca9509713ab59a830cf3cac10dd1f18af2323fb9e25b9928cdf133d390 |
| Animation/audio/stream        | 694ca97e7eba309d33b1491dfd477092387e5e1f6dd3fef463141c71d4a264cc |
