# Model material fidelity and cliff integration — in progress

The preceding coast/meadow/authority slice is pushed as game
`5f967b0f72fcacf98c499b423094f28f89eb32ee` and assets
`42d2bf84160dfdfb8b47339c5494ae85f69eed94`. Exact branch heads and GitHub
author/committer `dreaminglucid` are verified. All 18 committed TypeScript blobs
match probe48. Its spatial studies pass; the whole run still fails the 19 known
cow/dagger errors. No merge, deployment, or cliff installation occurred.

## Reproduced defects

An actual CPU Three/ModelCache three-mesh fixture sharing one physical material
and one ARM DataTexture was processed, serialized, structured-cloned and
reconstructed. No IndexedDB or GPU was simulated.

- Original one material becomes three cold; one shared texture becomes nine on
  persistent reconstruction. Pixel payload grows from 64 to 576 bytes in this
  deliberately tiny fixture. These are object/serialized-byte counts, not GPU
  allocations.
- Warm reconstruction loses mip/filter/wrap policy, UV1, texture channel and
  transform, anisotropy and environment intensity. Float colors are quantized.
- Cold conversion loses physical IOR/specular and forces metalness to zero,
  despite the outdoor environment now being present.
- Persistence identifies source bytes only by URL and length. Direct retry after
  a corrupted File can save a different parse under the failed File's identity.
- `shareMaterials:false` does not reliably provide independent material state.

## Ordered implementation and acceptance

1. **Static v7 persistence, implemented and narrowly qualified.** Exact successful parse-byte identity,
   shared source/texture/material/geometry tables, precise supported state, bounded
   complete validation and unique owned rollback. Reject incomplete old records.
   First admission is intentionally limited to supported static scenes and RGBA8
   DataTextures. Unsupported bitmap/compressed/animated/custom state falls back
   to real GLTF parsing; do not silently strip it. A File hash proves correspondence
   to ClientLoader's supplied bytes, not current upstream URL freshness. Root
   independently passes 60 tests across six ModelCache/codec/helper suites and
   scoped lint. All three normal builds and typechecks pass. Cold conversion/baking/
   sharing methods remain unchanged in this first slice.
2. **Native cold/warm qualification, passed in native02.** Use real browser IndexedDB,
   new pages with the same isolated origin/profile, actual path receipts and
   identical lighting/cameras. Distinguish a processed hit from parsing a cached
   File. Exercise a supported controlled GLB fixture plus an actual pond asset's
   safe fallback. Preserve mismatches, image/state hashes and ownership cleanup.
   CPU structuredClone tests do not establish this gate; actual native02 does
   establish it for these two cases, not arbitrary assets or finished shading.
3. **Cold material ownership and optical policy, not integrated.** A new isolated
   `copyPbrToNodeMaterial` helper has four real-class CPU tests and scoped lint
   passing. It preserves Standard/Physical scalar and map state, fresh material
   identity, separate mutable colors/vectors/ranges, and borrowed texture/node
   inputs without disposing originals. Non-PBR inputs return null; it does not
   decide whether an unlit asset should become lit. Source/vertex-color memoization,
   independent tintable clones, removal of forced zero metalness and native
   controlled visual tests remain to integrate and qualify separately.
4. **Full cliff facade rejected at both tested windows.** The northeast-bay seed
   leaves open edges up to 20.2m above produced terrain; all nine local adjustments
   fail. Eighteen western-ridge poses can bury boundaries, but useful exposure is
   tiny or conflicts with the conservative movement envelope. The best front area
   is only 13.15/13.07/12.79 square metres across the LODs. Do not install an 11.16MB
   asset carrying an estimated 64MiB of mipmapped RGBA8 textures for buried slivers.
   These are bounded CPU studies, not actual avatar collision or GPU proof, and
   do not establish that every possible site fails. The two frozen studies are
   `asset-studio/coastal-cliff-02-placement01` and `coastal-cliff-02-placement02`.
   A smaller closed outcrop or separately capped segment is the next asset choice;
   actual placement, visible collision/navigation, materials and cost stay open.

The helper's first test caught an additional native r186 copy detail:
`NodeMaterial.copy` omits inherited base `Material.alphaTest` in this conversion
path. Explicit base-material copying preserves the authored cutoff (0.35 in the
test). This matters for foliage cutout edges. The production loader is not yet
wired to the helper, so the test is not a claim of repaired live foliage.

## Frozen implementation verification

Root independently ran all six suites on 2026-09-11: 60/60 tests pass in 1.73s.
The native HTTP corrupt-File case uses actual World, ClientLoader and GLTFLoader;
it confirms direct retry cannot save under the failed File's digest. It does not
pretend Node provides browser IndexedDB. Six-file ESLint and Prettier checks pass.

| File | SHA256 |
| --- | --- |
| ModelCache.ts | `943e341598c9a5722c8bf7eaec566c0d328bfd2b4d2e1fb4f2f90f7a35b31d0d` |
| ProcessedModelCodec.ts | `19a59952ca3883ad5ca6df5257148ac8e567a708aba2f84356a076c44cafa9af` |
| ProcessedModelCodec.test.ts | `cbeee81a5f0f2e5935d245f8105862c1a5a866e5f803cc344acc4454eb2c893e` |
| ModelCachePersistence.test.ts | `a7cbeebd67a1d1f4f94b0eb86b6b0faf167970e267bad4066a3e521e3ae7f298` |
| ModelMaterialConversion.ts (not integrated) | `c2d0e4945674d9e3cdd23331773d3ecf53434ee228bc0d8ca66dfa2772b9bc13` |
| ModelMaterialConversion.test.ts | `e3ff2d9e64037e90a020d4a7b9eeba992162e7d33dfcd2db4ebf3930c479cd2b` |

Normal shared/client/server build and typecheck commands all exit 0. The client
still reports its existing Vite esbuild/oxc option warning. Built shared client
runtime SHA256 is `1261b1a8dff629ad4c70a82424b73ad3649903fb7f247d779b02c61549c59dfb`;
server index is `a1b751fd90fdfb7a5b14baf21c6b052b56acf6e81a34309b7049364dc96608be`.

Native harness preparation01 preserves a bundling failure before browser startup:
PhysX's guarded Node-only `require('fs')` needs the existing production browser
externalization policy. No fake physics/World/filesystem substitute is allowed.
A separately versioned corrected preparation is being made; no native cache gate
is claimed from that failed preparation.

Preparation03 subsequently passes with the production browser external policy:
1,188 bundled inputs; 1,217 source pins and archives / 22,440,661 archive bytes,
all independently verified. The 13,751,607-byte bundle has one guarded `fs`
external. Twenty CPU/source harness tests pass. Native01 then stops before model
loading or rendering because the isolated bundle lacks the existing client
compile-time `process.env` substitution (`EventBus`: process is not defined).
Owned browser/server cleanup succeeds. Preserve the failed evidence; apply the
actual client security/compile-time policy without exposing environment secrets
or creating a fake World/renderer. Native qualification remains open.

Preparation05 is independently verified: 25 CPU/source tests, all 1,226 source
pins and archive copies / 23,132,128 bytes. It uses the actual client literal
compile-time environment policy and explicitly accounts for esbuild's one
generated two-byte empty-object input; no filesystem or runtime module is faked.
Bundle SHA256 `6138fb7d1109b7777fd986b110df13981248e018e3e676b7b361083ed109c36b`
is 13,781,577 bytes. Native02 is now authorized under that frozen source closure;
all image/path/cleanup gates remain unchanged. The completed result follows.

## Native02 result — passed, independently reviewed

Executed 2026-09-11T21:15:11.292Z–21:15:31.509Z, actual headful Chrome152 and
Apple Metal-3 nonfallback WebGPU. Four fresh pages in one isolated context/origin,
two fixed cameras each, 640×480/DPR1, real RGBA16F targets and actual canvas PNGs.
This is a declared no-AA/no-shadow diagnostic policy, not a game-quality change.

| Case | Cold | Fresh-page warm | Matched near and oblique |
| --- | --- | --- | --- |
| Actual pond fern | Network1, parse1 | File IndexedDB1, parse1, network0, processed hit0 | Both pixel/readback and PNG byte-identical |
| Supported generated RGBA8 GLB | Network1, parse1 | File IndexedDB1, parse0, network0, processed hit1 | Both pixel/readback and PNG byte-identical |

The fern's unsupported bitmap normal/roughness sources correctly prevent whole-
scene processed persistence. The controlled fixture's committed native v7 row
has exact source SHA `380c69ac48c6e15dd72d8336d8e80deb7451b32de88c459adc283b1a233c4073`
and 18,308 source bytes, with 33,048 serialized typed-array bytes. Existing cold
duplication remains deliberately unchanged and is not claimed solved by v7.

Root verifies all 1,226 current source hashes and all 1,226 archived copies,
23,132,128 archive bytes, every original PNG/readback hash and size, recomputes
byte equality for all four image pairs, and visually inspects all eight PNGs.
Semantic receipts match including material, sampler, UV, geometry and sharing
classes. Nonblank content passes in all views (6,138–41,570 foreground pixels).
Actual draw calls/triangles are positive; their diagnostic intervals are not a
GPU-time or gameplay draw-budget measurement.

Zero page, console, GPU, observer or cleanup errors; zero browser warnings.
Four native devices are destroyed only during explicit teardown. All four pages
and renderers close, cache entry counts reach zero, browser and server close,
and the owned53030 port has no listener. The CLI's Node `require('three')`
deprecation warning is retained separately from browser/GPU results.

Report: `asset-studio/model-cache-qualification01/native02/report.json`, 717,965
bytes, SHA256 `055b23bc013ba9f441753622a3110e2a1c60325ed7d121e0214849040e54058f`.
Eight PNGs total423,612 bytes; eight native readbacks total19,660,800 bytes.
Failed native01 and preparation01/02/04 remain preserved, not rewritten.

**Art limitation:** the actual fern still shows dark/black patches under this
neutral diagnostic lighting. Exact cold/warm parity does not prove original-glTF
optical fidelity, correct back-face normal response, game-world lighting,
temporal quality, GPU cost, other assets, resource lifecycle or decoded streaming.
Do not use this pass as a claim that the current world has reached its art target.

## Next ownership and landscape slices

- Register load jobs before waiting for IndexedDB initialization; invalidate by
  job identity on remove/reset, so stale completion cannot republish a retired
  asset or remove a replacement job. Test real concurrent HTTP/GLB loads.
- Memoize conversion by source material identity and vertex-color requirement;
  retire replaced import-owned materials once, not once per consuming mesh.
  Private clones need separate mutable materials and material-array containers,
  while borrowing textures. Do not conflate this with a full refcount/eviction fix.
- Existing Entity and ProcessingSystem disposal paths assume independently owned
  geometry even though ModelCache clones share it. Audit/repair that actual
  ownership contract before claiming all entity/cache lifetimes safe.
- Restore dropped optical/sampler settings in a separately rendered candidate.
  Downstream dissolve conversion also needs attention: a physical material in
  ModelCache alone does not prove the final resource material preserves it.
- Stage [Poly Haven Rock Moss Set 02](https://polyhaven.com/a/rock_moss_set_02)
  under its [CC0 asset license](https://polyhaven.com/license), not website preview
  rights. Exact selected source is 3,581,402 bytes, seven individual rocks.
  Variants10/11/13 provide 23,928 source triangles with one shared three-map2K
  atlas. Their independent dimensions fit small outcrops, not cliff-scale relief.
  LOD preparation is isolated in `asset-studio/rock-moss-set-02-lod01`; no canonical
  installation, map-residency, native material or art acceptance yet.
- Compose bounded functional resource groves through the real generator and
  resource instancers, preserving current13 retained identities/positions. No
  decorative tree population or blanket global density increase. Actual approach
  navigation, depletion/regrowth, shadows/overdraw/LOD and stream readability are
  part of acceptance, not just a prettier screenshot.

Actual GPU timing coverage, cliff mip/seam/LOD transitions, image quality,
resource lifecycle, animations/audio, sustained performance and decoded streaming
remain separate launch gates. The current engine images remain below the target.
