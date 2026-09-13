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

The focused tests also exposed a separate same-JS-turn concurrent cold-load
race before the model-cache loading registry is published. This correction
does not resolve that race; it remains on the launch checklist.
