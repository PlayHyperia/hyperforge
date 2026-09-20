# World graphics development checkpoint — 2026-09-20

This is a work-in-progress source backup on `codex/sol-duel-stream-launch`,
not a release, merge recommendation, completed MVP or AAA-quality certification.
World art remains the priority: one compact island, open service pavilions,
one procedural arena, coherent live resources, and bounded WebGPU effects.

## Checkpoint policy

At each coherent, verified implementation slice, review the exact diff, run
relevant tests, check formatting/types and secrets, then commit and push to the
existing feature branch. Also checkpoint before a substantial new subsystem or
ending an extended work session. Do not accumulate another multi-day backlog.
Small later commits should identify their subsystem and retained evidence.

Use the user's configured `dreaminglucid` author and committer identity. Verify
the remote branch SHA after pushing. Commit related runtime assets separately
on their existing asset branch and record the paired revision. Do not merge,
deploy, promote experimental defaults, include real credentials or push local
databases, dependencies, captures, numbered conflict copies or recovery files.
An unresolved visual/performance gate stays open even when its source is saved.

## Repositories and scope

- Application identity fix: `3f5c36601d139e94a52746e4c84386fcc6d1a284`,
  already pushed and GitHub author/committer verified.
- Paired assets: `PlayHyperia/assets`, branch `codex/duel-arena-launch-assets`,
  revision `1869ff1503a00c3eda74ea99e8b1161406ec8b05`, pushed with both LFS
  objects and GitHub author/committer verified. Only two new runtime files:
  - `terrain/textures/compact-pbr/ground-height.png`, SHA-256
    `f83da0f031244f046d72adf229723da5857d36a6cd5fc542d11db019a60bc06c`.
  - `vegetation/compact-pond-v1/pond_sorrel.glb`, SHA-256
    `2f887028b517ad2e6ea3c75665dc4790c59a0ae66ea41ff6185e5b5375777d22`.
- This integrated source checkpoint retains the coupled terrain, shoreline,
  grass grounding/ownership, water optics, bank pavilion, rendering diagnostics,
  cache fidelity, local-runtime tooling and regression work since September 14.
  Newly imported source/JSON files travel with their consumers. The exact
  historical grass-worker fixture is now inside Git instead of a sibling
  authoring folder; its original byte/hash assertions remain intact.
- Experimental world manifests are **not** promoted. The asset repository's
  unrelated deletions, PhysX changes, candidate animations and local backups
  remain unstaged. Six application permission-only differences, numbered
  duplicates and unrelated package-manager copies also remain local.
- Hyperbet is a separate repository and is not changed by this checkpoint.
  Editable Blender files and diagnostic media in the external art workspace
  are not backed up merely by pushing application source or runtime exports.

## Verification and honest limits

- Initial changed-shared-source regression: **1,788 passed, 3 failed,
  10 skipped** across 59 files. This failed receipt is retained.
  Two failures were stale test expectations after the bank's eight upper braces
  moved into the roof cutaway and the bounded polygon limit increased to 32.
  Corrected tests retain exact post/brace masks and now prove both the exact
  capacity and atomic rejection above it. Both affected suites pass **41/41**.
- The third failure was the real grass grounding job reaching its existing
  active-CPU limit under concurrent validation load. The isolated two-case
  worker/synchronous parity rerun passes **2/2** without changing production
  limits, replacing clocks or weakening assertions. This does not qualify
  target-hardware performance; the initial failure remains meaningful evidence.
- Shared production-source strict TypeScript passes without emitted files or
  incremental writes. The focused actual Vite/GLTFLoader identity test passes
  **1/1**; it is not a native-browser visual test.
- Stock client readiness/stats tests pass **37/37**. The initial six readiness
  failures were caused by an old compiled shared bundle lacking the new bank
  admission getter. A narrow test-only source graph now binds the collector,
  real World/DataManager and procgen recipe consistently. The production
  readiness gate was not weakened and the playable bundle was not rebuilt.
- Bank art02 procgen tests pass **12/12**; physical geometry bytes, roof/footing
  hashes and historical smithy outputs are unchanged. Only the eight brace
  visibility labels changed. Fresh native art/motion review remains outstanding.
- The relocated historical grass fixture passes its actual worker proof
  **1/1**, with original SHA and semantics intact.
- A real inherited-pipe shutdown fixture race was corrected using an IPC
  readiness handshake after the descendant installs its signal handler.
  The shutdown suite passes **27/27**, including five consecutive isolated
  runs of that case; production shutdown behavior is unchanged.
- Serialized script verification with the explicitly selected Bun 1.3.14:
  **90 passed, 0 failed, 2 evidence-dependent skips**. This covers launcher
  shutdown, asset-gate/world-config validation, diagnostic pond policy, GPU-probe
  contract checks, Tailwind source scope and procgen source-map packaging.
  Earlier runs without the pinned Bun failed 12 validator cases; those failed
  receipts remain preserved. No runtime version requirement was relaxed.
- Isolated direct Vite development lifecycle: **three loaded graph/HMR/shutdown
  cycles pass**. Three preview shutdown cycles also passed in the earlier run.
  The concurrent first dev run's dependency-optimizer HTTP 504 remains retained;
  the passing rerun is not a claim that the first attempt succeeded.
- Native movement bootstrap tests remain **unqualified in this checkpoint**:
  two require ports owned by the protected playable session and fail with
  `EADDRINUSE`. No running human service was stopped or reused to obtain a pass.
  Next tooling task: an explicitly validated all-or-none local port tuple,
  ephemeral test allocation, and actual native gameplay rerun. The current
  movement harness source is preserved as work in progress, not certified E2E.
- Formatting checks and staged diff checks pass. Scoped ESLint found two DOM
  type names without a namespace in an existing browser-test helper; qualifying
  them through `globalThis` removes both warnings without changing runtime code.
  Checksum-verified Gitleaks 8.30.1 found no secrets in the staged source or asset
  changes. The formatting-only hook was run as explicit checks rather than
  allowing `npx lint-staged` to temporarily hide the dirty live working tree.

Never combine overlapping run counts or describe filtered/evidence-dependent
cases as passed. No complete full-repository or production-launch pass is claimed.

The protected human client on localhost:3333 and server on 5555/5556 remain
running. Their compiled shared client/server hashes are unchanged. Full builds
were deliberately not written over those live outputs. The bank integration's
earlier isolated matched build and native Chrome/Metal views remain evidence
for that specific candidate, not for subsequently edited art or performance.

Local checkpoint receipts are in `/private/tmp/hyperia-checkpoint-20260920.U3UHVG/`;
bank/physical/native receipts remain in
`asset-studio/game-test-integration/bank-pavilion-integration01-UNQUALIFIED/`
and `bank-pavilion-art02-UNQUALIFIED/`. Temporary checkpoint logs are local,
not durable GitHub artifacts. The launch checklist and graphics reference
library retain the longer-lived qualification narrative.

All seven world-art acceptance tasks remain open. Shoreline accounting remains
**3 checked / 8 open**. Bank service dressing/ground integration, arena artistry,
whole-island composition, particle coverage, movement, streaming, transactional
banking and measured multi-agent performance still require their stated gates.

## Follow-up checkpoint — bank art03 and expanded island layout

The verified source slice adds post-mounted bank key signs and asymmetric
service wear. The admitted bank recipe is explicitly v2, with exact readiness
metrics updated together: 1,492 triangles / 247,200 bytes / three batches.
Historical smithy geometry and non-pavilion paths remain pinned. No runtime
asset is added; the paired asset revision above is unchanged. Candidate
`assets-v2` remains a local, non-promoted overlay, not a GitHub-backed manifest.

Verification: 13 geometry, 32 path, 35 visual/cutaway, 11 native-owner,
4 selected candidate-owner, 2 candidate-access and 37 client tests pass.
Counts overlap and must not be summed. Strict source typing, scoped lint and
eight isolated bundles pass; all 145 protected compiled artifacts stay exact.
The first access invocation skipped all cases without candidate opt-in; the
first client invocation matched no files. Correct invocations and failed
receipts are retained, not silently counted as passes.

Native01 timed out at startup before art evidence. Native02 passes the unchanged
gate and produces three real Chrome/Metal views with stable pins and complete
HUD leases. Signs/cutaway improve locally, but pavilion dressing, dark ground,
angular grass, whole-world composition, motion and performance remain open.
A 114.6 ms maximum grounding-slice receipt needs isolated pacing investigation;
it is not a controlled comparison or a proven cause of the earlier timeout.
Owned diagnostics and temporary database are cleaned; human localhost services
and database remain unchanged. The evidence is local, not committed media:
[art03 review](/Users/lucid/Documents/hyperia/asset-studio/game-test-integration/bank-pavilion-art03-UNQUALIFIED/README.md).

The launch checklist and art brief now require LAYOUT-01–08: a small pavilion
town, multiple functional banks, distinct mines, island-wide tiered resource
trees with rarer high tiers, skill-local quest NPCs, scattered rune altars,
a naturally shaped farther-inland pond, and integrated gameplay/art/performance
acceptance. These are all open, with the singular schema/path dependencies
recorded explicitly. No forbidden comparative brand is introduced.
