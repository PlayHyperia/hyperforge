# Compact island lighting correction

## Verified problem

Actual Metal/WebGPU probe50 rendered the 29-tree island successfully. Its spatial,
presentation and resource-census checks pass; the whole run still fails with the
existing fourteen dagger-fit and five cow/avatar errors. There are no recorded
GPU/page errors and owned cleanup completed. The 39 images remain a development
checkpoint, not AAA, motion, streaming or production approval.

The recorded light and shadow-camera matrices establish a camera-height coverage
bug. Across six wide-view observations, all 66 station-ground receiver samples
are beyond far600 (depths 678.138–734.499m); 53 also lie below the light frustum.
All 660 corresponding samples from the other views are inside. These are repeated
measurements of eleven actual station-ground points, not 726 unique world sites.
The initial observation has no station-ground coordinates and remains unavailable.
The high camera is also the recorded light target.

The offline assessor uses the recorded world/inverse/projection matrices and
actual rendered ground heights. It does not reconstruct a desirable light ray or
update matrices. Frame/time/transform coherence checks pass, but there is no GPU
shadow-map freshness stamp and clip containment is not proof of shadow pixels.
Its nine tests pass. Source report SHA-256:
`8442a1e96308b98e21eace5ce92d97684bc250a859740e16f453456f941bebce`.
Derived station coverage in `asset-studio/compact-shadow-coverage01/`:
`963aa11d310d0d9b94ac9d092e58306bc9c6448da1d5c67e52bc156f027201bc`.

## Runtime changes

1. **Fixed compact shadow anchor.** For the admitted compact sculpt profile and
   existing single-map path, cache the profile's island center and base elevation
   at light construction/quality rebuild. Light and target translate together;
   the original unnormalized interpolated `-400 × direction + [0,100,0]` ray,
   radiometry, day/night timing and exposure are unchanged. CSM and noncompact/
   unadmitted behavior retain their camera anchor. No per-frame allocation,
   terrain query, scene traversal, adaptive fit or camera-position read is added
   to the compact path. The first compact light is positioned before rendering.
2. **Remove extra compact albedo lighting.** Terrain and grass no longer apply
   the custom teal half-Lambert tint and view-dependent Fresnel rim before native
   Standard PBR. Terrain uses its existing compact-PBR selection; grass uses the
   already validated terrain owner independently of blade-density/appearance
   settings. Legacy graphs remain intact. All six texture identities, fourteen
   material samples, normals, AO, roughness, pond/path/macro weights, blade
   gradients, geometry, wind, fog/output and shared sky/IBL remain unchanged.

Shadow allocation remains one 4096² map with ±200m extents, near/far0.5/600,
bias0.0002 and normalBias0.01. No new textures, render passes or instances are
introduced. More correctly included casters may increase GPU work; unchanged
allocation is not a performance result. The material change removes expressions,
but no frame-time improvement is claimed before measurement.

## Verification

- Root's combined run passes **422 tests across 41 files**, including actual
  World/Environment/Three matrices and the 29-resource lifecycle regressions.
- Ten directional-light cases cover construction, light disposal, camera-cut
  invariance, unchanged nonunit rays/radiometry/budget, actual center projection,
  CSM/quality rebuilds and a fresh real source process without admitted terrain.
  The first attempt incorrectly assumed Vitest had no admitted manifest; its
  normal setup already initializes one. The pre-admission case now runs in its
  own actual process instead of resetting or faking the active configuration.
- Actual terrain/grass node graphs verify the removed albedo dependencies,
  retained legacy dependencies, independent normal/output paths and precise
  root/middle/tip color arithmetic. Existing geometry hashes and complete compact
  texture/sample checks remain. The implementer's five focused suites pass40/40.
- All three normal builds and all three package typechecks pass, together with
  six-file lint/format/diff checks.
- Actual headful Chrome/Apple Metal 3 WebGPU probe51 passes the spatial,
  presentation and island study gates. All 29 trees (24 terrain-owned and five
  authored), 67 lighting/geometry observations and 11 restored HUD leases pass.
  The whole run still fails on the same fourteen dagger-fit and five cow/avatar
  errors; page/GPU/device-loss errors are zero and owned cleanup is complete.
- Independent root and camera audits verify all 468 current source pins, all
  399 archives (29,069,620 bytes), standalone-report equality and 39 original
  1280×720 PNGs. The validator, its tests, Bun policy and Environment test are
  separately attested before and after the run, not silently added to its archive.
- The unchanged recorded-matrix assessor places all 726 station samples inside
  the map: 66 observations of eleven ground points. The 66 wide-view samples
  previously outside are now inside, at depths457.531–476.350m. The initial
  observation still lacks station points and is explicitly unavailable. This
  does not certify shadow-map freshness, pixels or complete caster coverage.

Probe51 report SHA-256:
`b845a0c8526fa720528aba9aa75ed3b8419ba97e9853f792f031d7f4df651cd0`.
Derived station coverage SHA-256:
`b73ebafddf5594af6ebc667c3b8bdca4c14ec083efcad8546ca1706a79184739`.
The shared client build is
`5fafd351f2f184ef1fed4fa096b1fc6c0db65dec8bd95e819f0d2781dfc66f9d`.

Root reviewed the actual bank and wide images. Ground/grass appear more coherent
and tree shadows more readable; the broad lawn, repeated material and uniform
pale coast remain below the art target. Bank/wide phases are0.461897/0.637210,
different from probe50. This is not a matched-phase visual or performance A/B.
The real profile stays1280×720, DPR1, MSAA4 and one4096² map; no resolution,
population or quality reduction was used. Native timing and minimum hardware
remain unqualified.

## Still open

This fixes camera-driven coverage, not complete-world/full-day shadow quality.
Near-contact resolution, self-shadow bias, all caster bounds, off-camera caster
culling, shortened sun/moon interpolation rays and actual sustained rendering
cost remain open. An optional partial land/tree bound excludes stations, moving
actors, grading overlays and unbounded ocean; it does not authorize widening
depth. Its preliminary test run is3/4, with a vertical-camera basis fixture issue,
and is not represented as a complete certificate.

The terrain's existing lamp/vertex-light albedo multiplier and grass's terrain-
normal approximation remain. Sky chromaticity, fern dark patches, cold material
conversion policy, coastline/ground detail, architecture, motion and sound still
need separate work. Do not compensate by changing every asset's color or silently
reducing resolution, population or quality.

Three documents [normalized shadow bias and map-size cost](https://threejs.org/docs/pages/LightShadow.html)
and [per-cascade light ownership](https://threejs.org/docs/pages/CSMShadowNode.html).
These inform the retained single-map budget; they do not prove this game's
performance or visual quality.
