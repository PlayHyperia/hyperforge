# Imported material fidelity checkpoint

## Correctness fix

ModelCache no longer forces every imported material's metallic factor to zero.
That workaround assumed there was no environment lighting; OutdoorEnvironment
now publishes the scene's PMREM lighting. Authored metallic/roughness factors,
maps, zero values and glTF defaults survive cold import and cache reuse.
Factor 1 still multiplies the metallic-roughness map's blue channel; it does not
turn an entire mixed-material prop into metal.

Processed record schema remains v7. The material policy changes from
`static-r186-rgba8-v1` to `static-r186-rgba8-authored-pbr-v2`, so previously
flattened rows reject and rebuild from verified source bytes. This does not rely
on whether the asynchronous environment happens to be ready at import time.

## Evidence

- 40 focused tests across five importer/cache files, scoped ESLint/Prettier and
  whitespace checks pass. Real GLB cold/in-flight/memory/decode, exact old-policy
  rejection, factor/map identity, zero and default values are covered.
- Current working-tree regression: 1,258 tests / 92 files pass, and all
  shared/client/server typechecks and builds pass.
- Native Chrome/Metal WebGPU: all eight world views reviewed. The actual
  entity-bound bank chest, anvil, furnace and cooking range each retain their
  authored factors and shared MR map; all four delivered GLB bodies match their
  pinned source bytes. No fallback-root-only acceptance.
- Native report: `../asset-studio/game-test-integration/material-fidelity-native01/report.json`
  from the repository root, SHA256
  `bc8b3cc98ae5e58d59b425191d4176331e6e7c35c74cfd39e19848cc276a9cb2`.
  Verifier and compact result: `../asset-studio/material-fidelity01/`.

This capture includes other local landscape/bush candidates; those are not
promoted by the scoped importer commit. It is a source-pinned working-tree
observation, not a clean-commit screenshot or whole-environment approval.

## Open gates

The same 19 cow/dagger content errors keep the overall native run false.
Page/device/cleanup errors are zero; owned browser and services close.
Short p95 CPU ticks 14.7/13.5ms and GPU-pass sums 17.63/20.25ms (campus/meadow)
are not presented FPS, isolated cost, sustained60 or streaming approval.
Planting/lighting/terrain art and production performance remain unfinished.

The original material correction also exposed a separate same-JS-turn
concurrent cold-load race. Its follow-up is recorded below; the original
material-fidelity commit did not resolve that race.

## Cache-lifetime follow-up

Cold work now enters the loading registry synchronously, before decoder or
database initialization can yield. Same-turn callers join one parse. Removal
and clearing retire ownership before disposal callbacks; retired completions
cannot publish over, or delete, a replacement entry. Late unpublished scenes
release their unique resources, and retired parse failures cannot evict files
or start a retry.

Actual concurrent calls reproduce the original failure in
`../asset-studio/material-fidelity01/cache-same-turn-fail01.json`. The focused
follow-up passes 54/54 tests across five files, including real GLTFLoader
requests held in external-buffer HTTP responses, invalidation during parsing,
late resource disposal and replacement races. Final report:
`../asset-studio/material-fidelity01/cache-lifetime-final03.json`.

The integrated working-tree follow-up passes 1,278/1,278 tests across 92 files,
and shared/client/server typechecks and builds. Native WebGPU report
`../asset-studio/game-test-integration/service-soil-native01/report.json`
has SHA256 `513a1ac8134426c081c065d23673e7d57b597daa14a5e8b02e604cc2832bf21c`.
All eight focused visual/ownership checks pass with unchanged pinned sources,
while the same 19 content errors keep the overall run false. This capture also
includes local planting/landscape art experiments; it is not a clean-commit
image or performance approval. The optional GPU LOD/impostor path has not been
newly qualified by the CPU concurrency tests.

One build-contended broad run failed a grass grounding upload; the unaltered
250ms budget remains in force, and the standalone rerun passes. That retained
stress follow-up is not dismissed as a proven timing-only failure. Evidence:
`../asset-studio/service-planting-soil01/README.md`.
