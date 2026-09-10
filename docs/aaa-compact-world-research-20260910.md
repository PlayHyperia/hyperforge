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

## Current checkpoint and evidence limits

The latest pond runtime checkpoint is game
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
