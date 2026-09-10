# Development checkpoint — 2026-09-10

This is a work-in-progress source checkpoint, not a release, finished MVP, clean
PR approval or production certification. The user requested that the existing
backlog and subsequent coherent checkpoints be committed and pushed rather than
accumulating only on the local machine.

## Current scope

The compact agent island is the sole target world. There is no requirement to
retain the large island as a playable preset. Terrain shape, textures/materials,
shoreline, foliage and layout may be substantially rebuilt while retaining useful
WebGPU, LOD, instancing, culling, streaming and authoritative gameplay systems.
Persisted positions and user data still need safe migration. This supersedes
older large-world-preservation requirements in historical notes.

## Source backlog and repository hygiene

- The application backlog spans runtime/build tooling, Three WebGPU lifecycle,
  database migrations and custody, agent preparation and combat, streaming/UI,
  asset fitting/integration, lighting, terrain and their tests. These areas are
  interdependent; saving the checkpoint does not certify them individually.
- Local recovery/dependency copies and generated captures remain local. They
  accounted for most of approximately 5.4 GB of initially visible dirty/untracked
  files. No such files were deleted to clean Git status.
- Six tracked file-permission-only changes are intentionally omitted, including
  the two PhysX WASM copies. Their bytes equal HEAD and the local prebuilt file:
  SHA-256 `34c9abc37c8bfcc4242096636b13f574ace955c9933564638c4243cdae9b60b6`.
- Real environment files, local persistence, copied package-manager files and
  numbered file-provider duplicates are excluded from the source checkpoint.
- Application source, Hyperbet source and server world assets are separate Git
  repositories. External `asset-studio` authoring/harness files have no configured
  remote of their own; committing the application does not back them up.

## Verification at the checkpoint

- Client and agent-plugin package typechecks pass.
- Shared typecheck/build and server bundle build passed for the captured world
  candidate. The latest focused shared suite passed 30 tests in three files.
- **Server package typecheck fails** under its stricter compiler settings on
  imported shared-source implicit types/index signatures and a missing Three
  WebGPU utility declaration. This remains an open gate; a successful bundle
  build or shared-only check does not replace the server typecheck.
- Existing PhysX copy/prebuilt/runtime controls pass 7/7; both WASMs validate.
- A staged-change Gitleaks scan uses the checksum-verified official 8.30.1
  executable. The initial five findings were the same public authentication
  method discriminator, not secret credentials. The checked-in exception is
  restricted to that exact complete field expression; no file/category is
  exempted. Secrets and readiness must not be bypassed to obtain a checkpoint.
- Unified patch files intentionally preserve upstream context whitespace.
  Validate the actual Three patch and applyability, not by stripping its context.

## Latest actual world review: rejected candidate

The local `asset-studio/game-test-integration/outdoor-world-probe01` run completed
42 day/night comparisons (84 paired PNGs), plus three baseline comparisons.
It showed actual preparation NPCs/resources/stations and visible trees through
the opt-in preparation broadcast profile. Rendering was actual Chrome/Metal
WebGPU at 1280×720, DPR 1. No default lighting/world or source anatomy was promoted.

The overall run **failed** its outer camera equality assertion. The study's
atomic restoration matched its own acquisition pose exactly; the outer runner
incorrectly compared two later/earlier moving director poses. A versioned harness
correction is source-only until separately exercised. Keep the failed report.

Other retained findings:

- 14 genuine canonical dagger `missing_fit_metadata` console errors remain;
  there were zero retained page/GPU/HTTP asset/native lifecycle errors.
- Cleanup balanced 14 equipment attachments/removals, four private CPU
  geometries, 80 lighting controllers, one neutral environment and both outdoor
  maps. The owned browser/stack closed and ports were released.
- The palette removes the cyan cast, but night armor becomes nearly black and
  NPCs remain inconsistently bright. The brighter night variant is insufficient.
- Huge clustered trees, apparent floating/buried content, barren slopes,
  weak ground contact, poor station framing and HUD occlusion remain visible.
- Preparation currently inherits 16×16 terrain vertices over minimum 100 m
  chunks: 6.67 m spacing cannot reliably describe 2 m pond-bank transitions.
  Measure authoritative placement against actual rendered triangles before
  changing pivots or globally increasing detail.

Retained local report SHA-256:
`680c8130fcc987eba06f51e894728c05857f1afdabb7cd9d34e885ae2a724d96`.
Images and large raw reports are local evidence, not included in this Git commit.

## Next gates

- [x] Clear the strict server typecheck without weakening compiler settings.
- [ ] Finish checkpointing Hyperbet, actual world assets and authoring sources
  through their intended repositories/storage; verify remote branch tips.
- [ ] Correct actual terrain/contact and design the compact island and materials
  as one coherent composition, not another palette-only iteration.
- [ ] Complete gear coverage/bindings, equipped motion and shared outdoor lighting.
- [ ] Meet measured performance, real agent preparation/duel, streaming, SOL-only
  market lifecycle and endurance acceptance in the launch checklist.

## Follow-up: strict typing restored

The initial checkpoint's 53 strict server diagnostics are now resolved by
explicit shared-source parameter/dictionary types, concrete inventory-system
lookups, UI hit-test types and a narrow declaration for the installed Three
WebGPU upload API. No compiler flags, dependency versions, assets or runtime
logic changed. Server, shared and client package typechecks all pass.

Both implementation review and independent root verification compare the ten
modified runtime TypeScript files with the prior committed source: all ten
emitted JavaScript token streams match exactly, excluding whitespace/comments.
Eight emitted files match byte-for-byte; the two instancer files differ only in
printer line wrapping. The additional declaration has no runtime output.

ESLint with zero warnings, Prettier and scoped whitespace checks pass. The
following existing shared tests pass 68/68 across five files:

```sh
bun run test \
  src/extras/three/__tests__/createVRMFactory.materials.test.ts \
  src/extras/three/__tests__/createVRMFactory.boneTransform.test.ts \
  src/utils/rendering/__tests__/ModelCacheGeometry.test.ts \
  src/systems/shared/combat/__tests__/DeathUtils.test.ts \
  src/systems/shared/death/__tests__/PreparationDeathCustodyPolicy.test.ts
```

Run from `packages/shared`. The separate world/viewport suite also passes30/30.
These checks close the reported compiler failure, not visual/performance or
end-to-end launch acceptance. Existing game bundles were not rebuilt during
this type-only follow-up; rebuild before the next source-pinned GPU session.
