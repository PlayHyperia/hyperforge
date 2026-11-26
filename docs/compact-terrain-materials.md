# Compact island terrain materials

## Current work

Grass004 is the **selected ground substrate for continued art work**, after
the native58/59 comparison. It is not a production-approved world or a finished
meadow, and the larger transfer still needs optimization and measurement.
The aim is to replace the visibly illustrated, repeating grass carpet with a
finer, more natural ground surface. A texture alone does not provide a meadow:
terrain shape, planted volume, worn ground, shoreline and scenery composition
remain separate unfinished work.

Keep the comparison bounded: grass albedo/roughness and normal/AO, their
physical UV scale, and matching CPU/TSL color statistics change together.
Dirt, rock, paths, geometry, foliage density, placement, random sequence,
lighting, shadow settings, output resolution and renderer profile do not change.

## Source and precision

[ambientCG Grass004](https://ambientcg.com/view?id=Grass004) is a procedural
surface, approximately 1.4 m square, released under
[CC0](https://docs.ambientcg.com/license/). It is not a photographic scan.
Retain the four exact original PNGs and portable provenance in the asset
repository; reproduce packing with `scripts/pack-compact-terrain-textures.mjs`.
Do not depend on a particular developer's external asset-studio directory.

The existing decoder reduces the 16-bit OpenGL normal map to 8-bit. Packing
preserves those decoded channels, not the original normal precision. The
original normal remains available for a later higher-precision comparison.
Real source AO is retained in alpha; it is no longer a constant white channel.

| Grass pair                |  Existing | Candidate |
| ------------------------- | --------: | --------: |
| Encoded PNG bytes         | 1,857,089 | 6,444,310 |
| Map dimensions            | 2 × 1024² | 2 × 1024² |
| Packed format             |     RGBA8 |     RGBA8 |
| Nominal repeats per meter |      0.85 |   1 / 1.4 |

The candidate adds 4,587,221 encoded bytes. Equal dimensions and sample count
do not establish equal upload cost, GPU residency or frame time. Keep the
existing six-map / fourteen-surface-sample shader; no new render pass is part
of this material experiment. The existing ±18% projection-scale variation
means the physical tile size is nominal, not exactly 1.4 m everywhere.

## Color and ecology

Candidate linear diffuse mean is
`[0.12687350988906373, 0.16117143469264922, 0.03425721790414253]`.
Use gentle linear-reflectance meadow and dry-shoulder multipliers, checked
against actual texel maxima. The previous large red multipliers were tuned
to a different input and must not be carried over unchanged. Do not bake
exposure or sunlight into the source maps or the grass-base palette.

Verify real Node worker outputs from the same six production leaves before
and after: counts, offsets, rotation/scale/hash, blade tint and ground normals
must match exactly; only ground colors may change. This is a deterministic
ecology check, not native blade contact or GPU performance evidence.

## Visual acceptance

### Verified before the candidate capture

- Production client/shared and server builds pass; shared, client, server and
  procgen typechecks pass. The shared regression selection passes 781 tests
  across 58 files; the active capture harness passes 55 tests without skips.
- The portable packer passes five tests and its read-only `--check`. Dirt and
  rock outputs are byte-identical. Original normal quantization is disclosed.
- Actual Node22 worker comparison passes all six unchanged input identities:
  2,281 clumps (`271,503,139,532,493,343`), all 24 non-color array views unchanged,
  all six ground-color arrays changed. Before receipt is `worker-before03.json`
  (`1ba4d46d4b7d6120de5ec057b84a9c1dba6bc6245ded0b0d417f4de5ae530ab2`),
  after is `worker-after.json`
  (`3b83ee35529e3e73c29aa18fecc5ea63b294907513c4424bf3d1564edd31a1c3`).
- A separate root attestation covers the eight supporting source/provenance
  files omitted from the native capture's 535-pin closure. It does not enlarge
  that closure. Root independently passes the unchanged checker unit tests
  (3 tests / 30 expectations) with `cd scripts` then
  `bun test ./check-compact-grass-material.test.ts`. Repository-root filter-style
  invocation still exits silently; this tooling limitation is not concealed.

Local visual evidence lives in `asset-studio/game-test-integration` alongside
the game checkout. Native58 is the before capture; native59 is the selected
candidate capture. Keep
these diagnostics distinct from portable repository source and release proof.

- [x] Capture matched gameplay-close, bank, workshop, campus, ridge and bay views
      in headful Chrome using non-fallback Apple Metal WebGPU.
- [x] Compare camera/projection, daylight brackets, actual light/exposure/IBL
      receipts and unchanged scene inputs; disclose remaining wind/time differences.
- [x] Review all six before/after still views. Select finer ground detail and
      reduced directional repetition; retain sparse blade/contact, flat landscape
      and repetitive cliff texture as visible unfinished work.
- [ ] Qualify motion, distant mip transitions, normal direction and shimmer;
      still images do not establish these properties.
- [x] Preserve all loading, shader, GPU and asset errors. The known cow/dagger
      failures do not become acceptable merely because terrain renders.
- [ ] Measure transfer/upload and actual frame/GPU costs on target hardware.
      RAF intervals and structural counts do not qualify sustained smoothness.

### Native comparison result

Root independently verifies native59's 535 current source pins, 466 archived
files (36,259,870 bytes), and all 24 PNG hashes/dimensions. The existing pair
validator passes all 18 material images: exact camera/projection/resolution/DPR,
maximum daylight phase difference 0.004270543 (limit 0.01), maximum exposure
difference 0.000034706 (limit 0.005), and unchanged IBL allocation/settings.
Sun/wind/time and moving agents are not pixel-identical between sessions.

The new surface is finer, less saturated and less directionally repetitive.
It is still a uniform lawn with sparse oversized blades. The bank/workshop
remain sparsely furnished; the ridge is smoothly mounded with cobble-like rock;
the bay still exposes the finite ocean boundary. These are not accepted as
finished art. No obvious new grass seam appears in the inspected stills;
animated seam/shimmer and actual performance qualification remain open.

Native59 report SHA256:
`1fe641c3086a1b2928bf31c66d11d4cb248e26cb892357ccc4e2956940b62da5`.
The narrow material study passes, but the overall run **fails** the preserved
19 content errors (14 dagger fitting, 5 cow asset errors). Page/GPU error lists
are empty. Owned browser, game processes and database are closed; unrelated
services are untouched. The lightweight run deliberately does not establish
GPU lifetimes, sustained FPS, upload cost, multi-agent scale or launch readiness.

## Renderer headroom

The installed renderer is Three r186. A broad version upgrade is not required
to start this work. Native contact occlusion is a separate experiment described
in [the contact-shading plan](compact-contact-shading-20260912.md), not bundled
with the terrain comparison. [GTAO quality/cost controls](https://threejs.org/docs/pages/GTAONode.html)
include sample count, resolution and temporal filtering; more effects do not
automatically make the scene better.

After selecting the source material, qualify GPU texture compression rather
than simply accepting the larger PNG transfer. Three's
[KTX2 loader](https://threejs.org/docs/pages/KTX2Loader.html) supports Basis
transcoding to device-supported compressed formats. That requires a separate
channel/alpha/mip/color-space and visible-error comparison; it is not enabled
by this plan. Continue using existing instances, LODs and culling for richer
scenery; [batching](https://threejs.org/docs/pages/BatchedMesh.html) is available
where it fits the actual material and geometry workload.

The existing generic `optimize-assets.mjs` normal-map preset is **not suitable
for the packed normal/AO map**: its normal-mode encoding repacks components
and would lose independent AO alpha. Start the separate compression experiment
with UASTC RGBA without normal mode, alpha premultiplication or normal-map
normalization flags. Qualify actual selected device format and repeat-aware
mips; do not assume a Mac necessarily transcodes to ASTC.
[KTX creation options](https://github.khronos.org/KTX-Software/ktxtools/ktx_create.html).
