# Outdoor lighting chromaticity — bounded candidate, not final art approval

The first correction changes five precomputed linear-RGB endpoints in
`LightingConfig.ts`: moon, ambient night, hemisphere night sky/ground and shared
shade tint. Each retains 25% of its original chroma and 75% of its own achromatic
Rec709 luminance. This restores red illumination lost by the strongly cyan
original palette without changing light intensity, exposure, timing, explicit
day-light colors, source textures, avatar geometry or equipment.

Palette luminance conservation is **not** unchanged luminance on every colored
surface: restoring red deliberately changes skin and terrain response. The shared
shade tint also affects shaded daytime terrain/grass. No new per-frame work,
geometry, texture, shadow pass or render-resolution change is introduced.

## Verified CPU and build scope

- Twelve new tests exercise actual Three colors and terrain/tree/water material
  factories. Five endpoints and interpolated ambient/hemisphere luminance remain
  conserved; existing timing/exposure/intensity/day-color contracts remain fixed.
- The focused four-file owner/light suite passes 32 tests. Root's wider five-file
  terrain/pond/illumination/light suite passes 54 tests. These overlapping totals
  must not be added together as unique coverage.
- Shared typecheck, shared/server/client fresh builds, and scoped lint/format
  pass. Server competitive-build prefix: `6060db17ee8f`.

## Actual Chrome/Metal result25

The run completed 2026-09-11T01:57:54.517Z through 02:00:11.309Z. Report SHA-256:
`4c12a1dd3b27c9843d79ed1e2396cb02f657246c9378b13b3a03e1d17313b594`.
All 258 source pins remain unchanged, the same 11 spatial views/22 PNGs and six
baseline PNGs complete, and all six terrain-map/five-GLB HTTP bytes match their
pins. The new CPU regression file is separately recorded in this source
checkpoint; it is not one of that frozen runner's 258 capture pins.

Zero GPU/TSL/page errors or traced destroyed-reference submissions occurred.
Before cleanup the trace records 18,663 native submits, 349 texture creations and
two destructions. All native wrappers, Node flag, camera and equipment ownership
restore; browser closes, launcher exits zero, owned database exits and all four
owned ports are empty. The trace excludes render-bundle, compute and external
sampling; this is not representative performance evidence.

Root and independent review agree on the narrow benefit: exposed skin changes
from teal to muted gray-brown, the wall becomes neutral gray and the floor
olive-brown; bronze appearance is essentially unchanged. Skin remains too dark
and ashy against bright studio-lit bronze. Daytime pond/tree/hub views show no
obvious new regression but remain repetitive, sparse and overly saturated.
Retain this as a limited chromatic-contamination correction, **not finished
outdoor lighting or AAA art approval**.

Both kit camera transforms and all 11 spatial before-camera/resolution/DPR
records match probe24. Night intensity is zero and exposure approximately 1.1
in both, but night phases differ (.19320/.19496 versus .16923/.17048); natural
moon direction and idle motion are not frozen. Day intensity and exposure also
differ slightly. These are matched-view observations, not pixel-identical A/B
evidence. Under-loading-overlay PNGs remain explicitly diagnostic.

Overall integration still **FAILS** with the same five missing-cow messages and
14 canonical dagger-fit errors. Three adapter requests succeed again; the earlier
intermittent admission timeouts remain unexplained. No stream, launch or merge
approval follows.

## Remaining coordinated lighting work

Probe25's production scene explicitly had no shared PBR environment. Its diagnostic
armor borrowed a neutral studio map while baseline skin did not; ordinary
equipment also has a distinct metallicity fallback. Unify these with a bounded,
outdoor-calibrated environment and correct ownership. Do not promote the earlier
scene-wide neutral reference: its actual checkpoint31 made night ground too bright.

The subsequent shared-sky implementation candidate is recorded separately in
`outdoor-lighting-qualification-20260911.md`; probe25 does not qualify its changed
lighting, filtering or material-inheritance behavior.

Tree/water custom illumination remains opt-in and is not full shadowed PBR/IBL.
Keep their wind, alpha, normal/depth, foam and fog behavior while bringing their
key/fill response into the same lighting policy. Shadow/contact quality,
transition/motion review, actual stream output and sustained performance remain
separate acceptance gates. The complete island is still far below final art
quality; this candidate does not approve its composition, terrain or assets.
