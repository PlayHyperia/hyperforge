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

## Subsequent station-grounding checkpoint

See [the grounding evidence and remaining gates](world-grounding-checkpoint-20260910.md).
Game runtime revision `f191bddf32563df45bd623cd8e1d273615da54b4` on
`codex/sol-duel-stream-launch` is pushed and exact-remote verified. The paired
runtime-asset revision is
`233ba489fa97e72154fc8ab98060f4457dee8142` on
`codex/duel-arena-launch-assets`, verified on GitHub with both author and
committer `dreaminglucid` for both revisions. Normal formatting hooks ran; all
63 probe03 source/build/asset pins still matched afterward. Staged and committed
secret scans found no credentials. Hyperbet remains at the verified revision below.

Explicit-first station grading, pond outer blending into surrounding grading,
final chunk-height metadata, bounded edge-normal corrections and six actual
model-origin calibrations are implemented. The focused suite passes 73 tests in
11 files; shared/server/client typechecks, fresh shared/server builds and scoped
lint/format checks pass. These are not complete gameplay or performance gates.

Actual Chrome/Metal probe03 retained eight spatial views (16 PNGs in eight
ordinary/diagnostic pairs).
Ten station bases align with sampled rendered terrain; the prayer altar still
has a maximum sampled corner gap of about 0.15314 m. The spatial study passed,
but the outer run remains **failed** on a game-client process-group inspection
`EPERM` during shutdown. Browser, database and recorded ports closed; this does
not erase the failed cleanup audit. Grass exclusion, coarse pond triangles,
lighting, art, equipment fit and full compact-world qualification remain open.

Editable Blender sources are not remotely backed up. The separately reviewed
[source-backup plan](asset-authoring-backup-plan.md) awaits the user's private
repository destination decision; runtime exports are not editable-source backup.

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

## Verification at the initial source checkpoint

- Client and agent-plugin package typechecks pass.
- Shared typecheck/build and server bundle build passed for the captured world
  candidate. The latest focused shared suite passed 30 tests in three files.
- **The initial server package typecheck failed** under its stricter settings on
  imported shared-source implicit types/index signatures and a missing Three
  WebGPU utility declaration. The type-only follow-up below closes this specific
  gate; a successful bundle build or shared-only check did not replace it.
- Existing PhysX copy/prebuilt/runtime controls pass 7/7; both WASMs validate.
- A staged-change Gitleaks scan uses the checksum-verified official 8.30.1
  executable. The initial five findings were the same public authentication
  method discriminator, not secret credentials. The checked-in exception is
  restricted to that exact complete field expression; no file/category is
  exempted. Secrets and readiness must not be bypassed to obtain a checkpoint.
- Unified patch files intentionally preserve upstream context whitespace.
  Validate the actual Three patch and applyability, not by stripping its context.

## Initial actual world review: rejected candidate

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
- [x] Checkpoint Hyperbet source on its existing work branch and verify GitHub
  author/committer identity and the exact remote revision.
- [x] Finish the actual world-asset upload and verify its remote revision and
  GitHub author/committer identity.
- [ ] Back up external editable Blender/authoring and diagnostic harness sources
  through appropriate repository/storage; application commits do not cover them.
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

Run from `packages/shared`. The separate world/viewport suite also passes 30/30.
These checks close the reported compiler failure, not visual/performance or
end-to-end launch acceptance. Existing game bundles were not rebuilt during
this type-only follow-up; rebuild before the next source-pinned GPU session.

## Cross-repository source checkpoints

These are paired WIP revisions, not a release manifest or permission to promote
candidate assets to production defaults. Branch tips may advance through normal,
small follow-up commits; the immutable revisions below retain this checkpoint.

| Repository | Work branch | Checkpoint revision | Remote verification |
| --- | --- | --- | --- |
| Hyperia application (`PlayHyperia/hyperforge`) | `codex/sol-duel-stream-launch` | `7f50b5abfd0e41504645331390673af879115743` | Exact GitHub branch tip and account verified |
| Hyperbet (`PlayHyperia/hyperbet`) | `codex/sol-only-launch` | `25d8b41b9f4c2617fd9b885bb666a9f631f95be7` | Exact GitHub branch tip and account verified |
| Runtime assets (`PlayHyperia/assets`) | `codex/duel-arena-launch-assets` | `1a308a23d2c0f367d033d63698d60e68baa7e464` | All 212 LFS objects uploaded; exact GitHub branch tip and account verified |

All three commits map to GitHub user `dreaminglucid` as author and committer.
Both application-source branches were zero commits ahead/behind their upstream
after pushing; the asset branch was independently verified directly with
`git ls-remote` and GitHub's commit API. No branch was force-pushed, merged to
main, or deployed.

Hyperbet verification passed 125 Node tests, 79 Bun tests and the app typecheck.
Five other typechecks timed out and remain incomplete; generated-client
regeneration and launch E2E are still open. Its own full receipt is
`docs/release/2026-09-10-source-checkpoint.md` in the Hyperbet repository.
No GitHub Actions runs were returned for either source work branch at this check;
the local test receipts must not be described as a green GitHub CI run.

The asset commit contains 289 selected paths and no deletions. All 224 selected
GLB/VRM containers validate, all 54 selected JSON files parse, and the 212 unique
referenced LFS objects were verified against their exact hashes and sizes before
upload (834,881,528 bytes). Missing legacy files, cloud-only candidates, backup
copies and original authoring sources were not silently removed or certified.

The existing fresh-checkout asset bootstrap accepts `HYPERIA_ASSETS_REV` as a full
40-character revision. Use the asset revision above when reproducing this
checkpoint in a **new, isolated checkout**; the current bootstrap's existing-full-
asset fast path does not switch an already-populated checkout to that revision.
Verify the actual assets HEAD explicitly. Do not run bootstrap against a working
asset directory to discard or overwrite local work.

Redacted staged and committed-range secret scans passed with the reviewed narrow
noncredential exceptions documented in each repository. They are not proof of
the absence of every possible secret. Normal commit/LFS hooks remained enabled.
Stale owned-by-no-process Git locks were moved recoverably. A cloud-placeholder
asset branch reflog that blocked Git was preserved under a distinct recovery name
in the same metadata directory; normal Git writes then resumed. No commit
history or asset contents were discarded.

The workspace is intentionally **not described as entirely clean or backed up**:
six application permission-only changes, numbered local copies, local package-
manager files, cloud-only legacy content and external `asset-studio` sources
remain outside these checkpoints. Continue small, scoped commits with explicit
staging, proportional tests, secret scanning and exact remote-ref verification.
