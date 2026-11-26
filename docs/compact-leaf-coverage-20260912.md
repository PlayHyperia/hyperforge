# Compact leaf coverage checkpoint — 2026-09-12

This is a tested graphics-branch candidate, not production, whole-scene art or
performance approval. No textures, geometry, resource placement or density changed.

## Change

Only original mapped, alpha-bearing materials in the admitted compact sculpt
profile select filtered alpha and native r186 alpha-to-coverage. Original source
flags, not material names, identify leaves; converted dissolve flags cannot do so.
Frozen owner diagnostics record selection without claiming hardware activation.

Native r186 smooths alpha over [T, T + fwidth(alpha)]. The initial unshifted .5
threshold visibly thinned crowns and was rejected after native65 image review.
The centered successor uses max(.5 - .5*fwidth(alpha), originalDissolveThreshold).
The original threshold is zero or two, retaining Bayer distance/depletion
decisions and preventing a negative cutoff. Bark and legacy material branches,
RGB/AO/wind/fog, map identities, opaque depth writes and single-sample shadow
behavior remain unchanged. No extra texture or render pass is introduced.

## Evidence

- 14 actual material-graph tests; 911 shared tests across 73 files.
- Shared/client/server typechecks, scoped lint/format, client/shared and server
  builds pass; 94 capture-tool checks pass.
- Native66: actual nonfallback Apple Metal WebGPU, 1280×720, DPR1. All 18
  exact-camera/daylight pairs match the immutable native64 reference.
- Root verifies 592 source pins, 523 archives, all 24 PNGs, 48 fog brackets and
  both island censuses. No page/GPU/cleanup errors. All 19 pre-existing cow/
  dagger content errors remain, so the overall run still fails.
- Root-reviewed scenic stills recover the crown fullness lost in rejected65.
  Owned test browser, launcher and service ports were closed.
- Native66 report SHA256:
  `e197e28a0598a9e2cc29b06221eb3c46057e0f3881d017f1c7e41bdfa34f07b8`.

## Remaining gates

Motion/shimmer, minification and alpha-mip coverage, zero-derivative/exact-cutoff
cases, all species/LODs and live harvest/depletion need native qualification.
Widths above one retain a coarse-gradient limitation. The existing shadow pass
still omits custom dissolve nodes; that is not fixed here.

Passive native observations find existing four-sample render-context/attachment/
pipeline handles for selected leaves and opaque controls. The hardware alpha
coverage descriptor is unavailable, not proven enabled by this observer.
GPU cost, presented frames, loading, thermal stability and scale remain open.

Primary references: installed Three r186 NodeMaterial/NodeBuilder/WebGPU sources,
[Three Renderer documentation](https://threejs.org/docs/pages/Renderer.html),
and NVIDIA's [Hashed Alpha Testing paper](https://research.nvidia.com/sites/default/files/pubs/2017-02_Hashed-Alpha-Testing/Wyman2017Hashed.pdf)
for the distinction between edge smoothing and preserving distant coverage.
