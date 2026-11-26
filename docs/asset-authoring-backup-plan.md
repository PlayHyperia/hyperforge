# Editable asset source backup plan

Status: **planned, not backed up off-device**. Read-only assessment: 2026-09-10.
This document does not approve asset quality, change runtime asset pins, or
authorize repository creation, branch creation, uploads, or deployment.

## Verified gap and bounded inventory

The studio at `/Users/lucid/Documents/hyperia/asset-studio` is not its own Git
repository. Its enclosing workspace is an unborn repository without a remote.
The pushed runtime assets in `PlayHyperia/assets` do **not** preserve these
editable Blender sources. Do not stage the enclosing workspace wholesale.

A metadata-only traversal inspected 17,442 files, skipping 177 backup, cache,
dependency, staging, and diagnostic directories. It found:

| Category | Blender checkpoints | Logical size, decimal GB |
| --- | ---: | ---: |
| Anatomical avatar work | 97 | 1.27 |
| Equipment production | 212 | 3.51 |
| Other inspected studio work | 22 | 0.25 |
| Total | 331 | 5.03 |

Every inspected nonempty file had allocated blocks; no zero-block cloud
placeholder candidate was observed in this bounded set. This is **not** a
complete byte-read, hash, dependency, or excluded-directory availability check.
Equipment and runtime-review JSON alone total approximately 29.5 GB and include
large generated diagnostics. JSON also contains useful recipes/manifests: do not
exclude the entire format or bulk-copy the studio.

## Exact preservation candidates

The following file paths were individually confirmed to exist as allocated
regular files. Paths are relative to the studio above. They are starting
candidates, **not a complete source closure or a newest-file promotion rule**.
Retain all `UNQUALIFIED` labels and preserve body38 separately from later grip WIP.

```text
anatomical-adventurer-v1/source/realistic_human_base.blend
anatomical-adventurer-v1/ATTRIBUTION.md
equipment-production-v1/weapons/right-hand-fit-work/power-grip-pilot18-work/grip20-work/hand-repair38-work/native-index38-01/index38-local-repair-UNQUALIFIED.blend
equipment-production-v1/weapons/right-hand-fit-work/power-grip-pilot18-work/grip20-work/contact-grip48-work/native48-01/grip48-working-checkpoint-UNQUALIFIED.blend
equipment-production-v1/armor-torso/game-lod01/native01/complete-platebody09-LOD01-UNQUALIFIED.blend
equipment-production-v1/armor-legs/complete-game-kit01/native03/complete-platelegs-study02-UNQUALIFIED.blend
equipment-production-v1/projectiles/arrow-work/game-test-export01/native01/arrow03-baked-game-test-UNQUALIFIED.blend
equipment-production-v1/weapons/scimitar-work/working-direction04-work/native-direction04b-01/scimitar-blade-direction04b-UNQUALIFIED.blend
equipment-production-v1/tools/hammer-work/normal04-work/portable06-work/working-direction07b-work/native-direction07b-01/hammer-external-working-head-UNQUALIFIED.blend
equipment-production-v1/tools/pickaxe-work/common-profile01-work/native-wood01-work/working-direction02-work/native-direction02-01/pickaxe-external-working-head-UNQUALIFIED.blend
equipment-production-v1/tools/hatchet-work/common-profile02-work/wood-uv03-work/working-direction04-work/native-direction04-01/hatchet-canonical-grip-working-head04-UNQUALIFIED.blend
portable-import/README.md
portable-import/full_float_normals.py
game-test-integration/ASSET_GAME_TEST_CHECKLIST.md
equipment-production-v1/GEAR_COMPLETION_TRACKER.md
```

The checklist records the combined repaired38/eye04/neutral-shorts02 avatar.
The exact eye/shorts/assembly dependencies and remaining helmet, boots, gloves,
shield, sword, bow and staff sources still need explicit closure resolution.
The torso LOD source alone is not a substitute for its complete-resolution source.

## Required source-closure and recovery checks

- [ ] Map every retained runtime/test asset to its exact saved source and recipe;
      include meaningful native/UI edits that scripts cannot reproduce.
- [ ] Inventory each Blender file's linked libraries, images, packed images,
      fonts and other external dependencies. Preserve original sources unchanged;
      resolve relative paths in an isolated copy and detect missing dependencies.
- [ ] Include required source textures, authored assembly/export/import scripts,
      small settings/manifests, Blender/add-on versions and reproducible commands.
      Exclude copied dependency bundles, caches, videos, screenshots and large
      generated readbacks unless specifically needed for source reconstruction.
- [ ] Include licenses, attribution and modification disclosures. The anatomical
      foundation is Julien Kaspar / Blender Studio's Realistic Human Base,
      **CC BY 4.0, not CC0**, as recorded in `ATTRIBUTION.md`.
- [ ] Record relative path, byte size and SHA-256 for every included file; reject
      placeholders, unresolved dependencies and changed-during-copy inputs.
- [ ] Scan textual inputs for credentials without exposing secret values. Review
      packed/linked contents and filenames before publishing the archive.
- [ ] Verify archive listing and safe paths, extract into a separate empty
      directory, rehash every member, and fresh-open representative source files
      with untrusted script auto-execution disabled. Check dependency closure and
      a representative export without modifying original sources or runtime pins.

These recovery checks establish preservation, not visual, fitting, animation or
performance acceptance. A Git bundle alone also omits Git LFS object contents.

## Publication and deployment boundary

`PlayHyperia/assets` is **public**. Its `Caddyfile` serves `/app` without an
authoring-directory exclusion; `Dockerfile.server` copies the whole world tree;
`scripts/ensure-assets.mjs` clones the asset tree and development pulls LFS files.
Adding authoring sources to a runtime revision would increase checkout/image
contents and could expose editable files through the CDN. Existing asset LFS
rules do not include `*.blend`.

Read-only GitHub inspection found three workflows: documentation updates on
`main` pushes, PR review, and comment/issue actions. Ten GitHub Environments have
no branch restrictions/protection rules. There are 26 historical Railway-created
deployments (newest 2025-11-30); two sampled latest statuses were inactive. The
current runtime checkpoint had no recorded deployment. None of those observations
proves Railway auto-deploy is disconnected or excludes an authoring branch.
The visible push webhook is a Discord notification, not proof that GitHub App
integrations are absent. Railway's current source-branch settings remain
**unverified**. The game's local main/dev deployment documentation does not
establish the assets service's settings.

Decision pending: the user has been asked whether to create a separate private
`PlayHyperia/hyperia-asset-sources` repository or retain a local-only backup.
Do not create that repository, publish to the existing public remote, or push an
authoring branch until the destination and deployment isolation are approved.
A future private source repository needs explicit Blender/binary LFS rules,
storage review, and verification that both Git and LFS objects restore remotely.

## Safe local-only next step

Proposed destination convention, **not yet created**:

`/Users/lucid/.local/share/hyperia/asset-authoring-checkpoints/<UTC-timestamp>/`

Before use, verify the resolved path is a new directory on local storage, not a
symlink into Documents/iCloud/File Provider or a live runtime checkout; check free
space. Prepare a selected-source archive plus manifest and recovery receipt there
without moving, overwriting or deleting originals. Do not use temporary storage
as the durable checkpoint. Preserve relative paths and retain failed checks.

This is a second **local** copy: it helps recover accidental edits but does not
protect against loss of the Mac or disk. Off-device backup remains open until an
approved private destination contains the source bytes and a restore is verified.
