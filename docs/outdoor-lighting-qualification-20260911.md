# Outdoor lighting qualification — 2026-09-11

**UNQUALIFIED for final art, radiometry, sustained performance and full lifecycle.**
Actual-world probe26 completes the bounded day-lit integration checks below;
the whole integration remains FAIL on existing content errors.
The contract below is not itself a successful capture report. Verification is
recorded separately; do not reinterpret CPU calibration as rendered proof.

## Intended runtime contract

[OutdoorEnvironment](../packages/shared/src/systems/shared/world/OutdoorEnvironment.ts)
prepares twelve sky-derived PMREMs during loading, at phases
`0, .125, .22, .25, .28, .32, .5, .68, .72, .75, .78, .875` of the existing
four-minute cycle. Each captures six faces at **128 × 128**, stored in one
384 × 512 RGBA16F CubeUV atlas. The twelve atlases contain **18,874,368 bytes
(18 MiB) of base color storage**, including their packed roughness levels.
This is **not total GPU memory**: filtering scratch targets, possible depth
storage, bindings, pipelines, geometry and the rest of the renderer are additional.

[SkySystem.createLightingCapture](../packages/shared/src/systems/shared/world/SkySystem.ts)
uses the existing starless atmospheric equations with independent phase uniforms
and a palette snapshot. It includes broad atmospheric sun/moon glow, but no
sharp celestial discs, stars, clouds, actors, terrain, water or viewport nodes.
An explicit lower hemisphere replaces the shader's mirrored underside. That
ground contribution is a hemispherical approximation, not measured terrain
bounce or dynamic global illumination. No studio reference or asset recoloring
is part of the source contract.

Initialization runs through the renderer preparation queue, drains submitted GPU
work between captures, and restores render-target/output state after capture.
Captures store linear radiance without display tone mapping or exposure; the
normal world output configuration is restored. The scene environment is published
only after preparation succeeds. A caller deadline is not cancellation of GPU
work; pending work retains ownership until it settles.

Steady updates select adjacent cached maps and update one blend weight in a stable
`mix(pmremTexture(a), pmremTexture(b), weight)` scene node. There is no steady-state
PMREM regeneration. Both maps are sampled for the relevant environment lighting
terms, so this is not zero-cost. Material-level `envNode`/`envMap` overrides must
not silently bypass the shared scene policy. The authored-scene equipment path
preserves authored metallicity and leaves `envMap` null.

## What the calibration actually preserves

`sampleOutdoorFill` derives upward and downward irradiance budgets from the
configured ambient and hemisphere light colors/intensities. The direct sun/moon
is separate and retained. Once the outdoor environment is ready,
[Environment](../packages/shared/src/systems/shared/world/Environment.ts) suppresses
the analytic ambient/hemisphere intensities rather than adding IBL on top.

For each phase, 16 radial × 32 azimuth midpoint samples use cosine-weighted upper
hemisphere directions (`y = sqrt(u)`). With linear Rec709 luminance `Y`:

```text
E_sky_up ≈ π × mean(sampled sky RGB)
skyScale = Y(target upward irradiance) / Y(E_sky_up)
groundRadiance = target downward irradiance RGB / π
```

This matches **upward luminance in the finite CPU quadrature**, not upward RGB.
The constant lower hemisphere matches **physical downward RGB irradiance before
filtering**. It does not establish all side-facing normals, azimuths, full-sphere
color, or the old hemisphere-light response on every surface. A scalar preserves
the sky's chromaticity: blue/cool sky light can still color skin. Matching a light
budget does not make skin neutral or preserve luminance after multiplication by
colored albedo. Night retains a nonzero downward fill budget; it is neither
disabled night nor proof of acceptable night contrast.

Interpolation is continuous between cached maps, but it approximates the live
atmosphere between samples. The source cycle still has its existing intensity
jumps at `.28` and `.72`; the blended cache does not prove exact continuous
agreement with that source. The snapshot also does not follow later live palette
edits without a separately managed replacement cache.

## r186 filtering qualification

Three r186's PBR environment path obtains diffuse irradiance by sampling the
prefiltered environment at roughness 1 and multiplying by π; specular uses its
roughness-dependent environment lookup. These are renderer operations, not the
CPU integration above. [Three r186 EnvironmentNode](https://raw.githubusercontent.com/mrdoob/three.js/r186/src/nodes/lighting/EnvironmentNode.js).

The installed common PMREM generator filters successive levels with incremental
GGX VNDF importance sampling. Its finite filtering, roughness mapping and atlas
sampling are not identical to a single physical cosine convolution. Therefore
neither upward CPU luminance nor downward prefilter RGB equality guarantees the
same equality in the actual r186 diffuse result. Older r183 calibration receipts
cannot qualify this filtering epoch. [Three r186 PMREMGenerator](https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/common/extras/PMREMGenerator.js).

Actual qualification must compare **RGB**, not only mean luminance, for up, down
and multiple side directions, at diffuse and representative specular roughnesses.
Use genuine render-target PMREMs with the installed orientation convention;
relabeled uploaded textures are not equivalent evidence.

## Material coverage boundary

- Terrain uses PBR, but retains its separate pre-lighting shade treatment.
- The current quadtree caller in `TerrainSystem` constructs `GrassVisualManager`;
  its actual factory creates `MeshStandardNodeMaterial` and returns PBR output
  RGB. That path can inherit scene IBL, while its terrain-normal override and
  pre-lighting tint remain separate. **Verify actual rendered mesh/material
  identity** before claiming grass coverage.
- `ProceduralGrass` also contains distinct `MeshBasicNodeMaterial` custom-RGB
  paths. They do not become PBR merely because scene IBL exists.
- GLB tree and lake/ocean shaders have custom output-color paths. Their separate
  illumination/tint/reflection controls are not automatically unified by this
  scene node. Shared color constants alone do not establish shared radiometry.

See [GrassVisualManager](../packages/shared/src/systems/shared/world/GrassVisualManager.ts),
[ProceduralGrass](../packages/shared/src/systems/shared/world/ProceduralGrass.ts),
[GPUMaterials](../packages/shared/src/systems/shared/world/GPUMaterials.ts) and
[WaterSystem](../packages/shared/src/systems/shared/world/WaterSystem.ts).

## Pending actual evidence

- All twelve native outputs, formats, orientation and readiness; restored renderer
  state; no unexpected GPU errors; correct partial-failure/teardown ownership.
- Directional RGB/roughness comparisons and map-interval seams, including midnight
  wrap and both transition windows.
- Startup CPU/GPU duration, actual resident memory and steady frame-time tails
  with ordinary content/animation—not just an empty scene or average FPS.
- Matched day/dusk/night images of skin, authored metal, terrain, active grass,
  trees and water under the same environment policy. Preserve exposure, assets,
  camera and material provenance; inspect contrast and color visually.

## CPU and build verification

- Seven focused shared suites pass 100 tests: actual sky-node arithmetic,
  analytic fill calibration, interval selection, authored material inheritance,
  resource ownership/failure cleanup and renderer queue semantics. Seeded CPU
  PMREM nodes/targets are explicitly not GPU filtering evidence.
- The normal client build exposed five impostor and 90 procgen r186 type
  diagnostics. Narrow node-argument types now accept the correct typed nodes;
  three color projections and two explicit uint conversions preserve existing
  shader behavior. The historical integer grass-hash behavior is deliberately
  not changed in this compatibility pass.
- Procgen's full real CPU suite passes 673 tests across 21 files. Its emitted-JS
  comparison against the previous source matches after normalizing only the
  stated identity color projections and existing integer-coercion boundaries.
- The normal client build, including its five-task dependency graph, passes.
  Shared type/declaration generation and refreshed server build also pass;
  server competitive-build prefix is `b3ee378ba708`. The attempted broader
  all-package build stopped at procgen before the fix and is not certified by
  the narrower successful builds.
- That broader build regenerated model bounds with diagnostic asset entries;
  this generated change was restored to the exact original asset-Git blob
  `fefadd5b5cc244408f112754aa7c2fc28bc5e849`. The generated copy remains at
  `/private/tmp/hyperia-build-generated.FwhPX2/model-bounds.generated.json`.
  Existing unrelated PhysX/LFS work remains untouched.
- Queue checkpoint `027d7552bf50c11daa40b4166709ae7892e3f25e` is pushed with
  exact remote and GitHub author/committer `dreaminglucid` verified.

## Actual Chrome/Metal probe26

Run: `2026-09-11T02:43:17.745Z` through `02:45:37.497Z`. Report SHA-256:
`83f03a75adbe5845b58bbb34f7f2e8870d7c4a902eeb1c5fdf015fdb6cae8dca`.
Spatial-study SHA-256:
`5f4bb56aa93a1549e711c190398fee578e5fd615b0aba23a41fc18da245d0be5`.

- All 292 current source pins, 228 archived source copies and 28 PNG hashes
  independently match. Eleven spatial views/22 PNGs plus six baseline PNGs
  complete at 1280x720/DPR1. Thirty-seven admin receipts return HTTP200.
- The actual owner reports twelve completed maps, 18,874,368 base-color bytes
  and 1,865.7ms preparation elapsed time. That time includes startup submission
  and GPU waits; it is not an isolated GPU timestamp or steady-state frame cost.
- All 45 sampled spatial receipts show one stable environment node, 70 private
  avatar/equipment materials with zero map/node overrides, terrain inheritance
  and zero diagnostic environment allocations or scene-light writes. Two adjacent
  phase intervals are sampled. The observer does not create a studio map.
- Zero GPU/TSL/page errors or traced destroyed-reference failures. Before cleanup:
  9,168 native submits, 360 texture creations, two destructions. Bounded ring
  history and untracked render-bundle/compute/external sampling remain explicit;
  these counts do not establish complete resource usage or performance.
- All fourteen diagnostic attachments detach, four owned CPU geometries retire,
  no studio environment is disposed, camera/director and wrappers restore.
  Browser closes, launcher exits zero, owned database exits, four ports are free.
  The runtime environment is still ready at observer cleanup: this does **not**
  prove explicit `OutdoorEnvironment.dispose()` on a live renderer or reconnect.
- Overall **FAIL** remains: five missing-cow/404 messages and fourteen canonical
  dagger-fit errors. The baseline loading overlay remains in normal screenshots;
  images with it suppressed are expressly diagnostic. No actual streaming
  source-epoch, broadcast, production equipment delivery or fit approval follows.

### Visual review and comparison limits

Exposed daylight skin reads pale pink/gray rather than strongly cyan. Bronze is
dark with insufficient front-facing definition, and the HUD partly obscures faces.
The kit cameras match probe25, but probe25 was night (phase approximately .170,
intensity0, exposure1.10) and probe26 is day (.366-.368, approximately .960/.851).
**This is not evidence that the night-skin defect is fixed.**

Tree, pond and hub cameras match exactly and their phases are closely comparable
to25 (differences below .0005). Their appearance is materially similar: saturated
green/coral/cyan crowns, a green-carpet ground treatment, an engineered pond bowl,
sparse dressing and the six-arena campus remain art-rejected. Shared IBL alone
does not resolve these composition and custom-foliage problems.

The source audit also finds no current cross-renderer map-sharing route: normal
minimap is Canvas2D with CPU terrain samples; equipment/dialogue previews create
their own scenes. A real normal-client minimap/portrait open-close smoke test is
still required; stream26 does not execute it.

Compatibility checkpoint `307aa030f6ea14807e162c6a025f101480d0db21` is pushed;
exact remote and GitHub author/committer `dreaminglucid` verified. External
authoring/capture files remain outside this game-Git checkpoint.

## Actual natural-night probe27

Run: `2026-09-11T02:52:04.796Z` through `02:57:28.755Z`. Report SHA-256:
`17a2b7a0a7598b39c7f3a918380b7ca8655d8ba112a5039d196cb03603f887d2`.
Spatial failure-report SHA-256:
`55236371edc48425210ce748f950cb884a070d6c77f16278d4742ac656434922`.

- Six baseline PNGs, all hashes/dimensions independently verified. All 294
  current source pins and 230 archived pins match. No spatial views completed.
- The world advanced naturally to night; no clock, light or exposure writes.
  Kit0 phases .161428-.162121 and kit1 .162609-.163303 have day intensity0 and
  exposure1.10. Kit cameras match25 exactly, whose phases were approximately
  .169-.171 with the same day intensity/exposure. Moon direction and world actors
  can differ; the baseline-world cameras do not match.
- Exposed skin reads pale lavender/gray without pronounced cyan in these views,
  but remaining cool tint and facial readability are unresolved. Bronze reads
  dark brown/near-black and loses too much chest, glove, boot and shield detail.
  This reduces the private-studio/night-world mismatch without delivering final
  night art. HUD obstruction and diagnostic equipment injection still limit
  claims about fitting, animation and normal equipment delivery.
- Owner admission reports 12/12 maps, 18 MiB base color and 741.5ms preparation
  elapsed time. This is not isolated GPU time or sustained performance evidence.
- Zero GPU/page/cleanup errors; all fourteen attachments detach, owned geometry
  retires, native wrappers restore, browser/launcher close and four ports are
  free. Bounded trace history and untracked sampling paths remain limitations.
- Overall **FAIL**: the later study13 line994 readiness predicate timed out.
  All eleven stations and fifteen of sixteen resources passed both snapshots.
  The exact-ID fishing spot `fish_341_308` had moved from initial expected
  (340.5,307.5) to (347.5,306.25), so the strict initial-position gate failed.
  Identity/type/resource identity, network and terrain admission still matched.
  The study began at world age265.5s, after the server's initial fishing-move
  window of120-239.4s. Relocation is expected behavior, but this run did not
  record authoritative move-packet/target lineage. Do not waive the failure or
  infer valid shore placement from these client snapshots. A future study must
  explicitly verify the moving-resource lifecycle. The five cow/404 and fourteen
  canonical dagger-fit errors remain additional disqualifying content failures.

The same fishing snapshots also record replicated Y27.8 but live node Y26.98265.
Source review finds a plausible separate mechanism: generic remote rotation
updates can enroll a non-character resource in tile interpolation, whose next
stationary update follows terrain height. Exact packet ordering was not captured.
Reproduce with real resource/network/interpolator classes in both move-packet
orders before claiming a fix; preserve water height and character behavior.

The seven focused shared suites were rerun after capture: 100/100 pass. Normal
client/server typechecks also pass. Neither result replaces actual art, gameplay,
native owner teardown, radiometry or sustained performance acceptance.

**Night evidence collected; final production/artwork acceptance remains open.**
