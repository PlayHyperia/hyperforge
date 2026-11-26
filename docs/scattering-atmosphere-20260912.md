# Clear-sky scattering and HDR fog — 2026-09-12

Status: tested opt-in atmosphere candidate; not default, performance, AAA or
launch acceptance. Current art still needs substantial terrain, vegetation,
architecture, character/material and presentation work.

## Runtime change

`SkySystem` uses the same `ScatteringSky` day radiance for visible sky,
starless fog, environment capture and CPU irradiance sampling. Each environment
capture owns independent sun/coefficients; CPU sampling cannot mutate GPU
capture phase. Existing stars, moon, full-night palette, sun direction/time
equations and the separate solar sprite remain. The existing discontinuities
at day phases .28/.72 are preserved, not solved by this work.

The analytic model adapts the installed Three r186 SkyMesh equations, with its
MIT notice retained in source. Fixed candidate parameters: turbidity 2,
Rayleigh 2, Mie coefficient .005, directional g .8, linear radiance scale .14.
That scale is independent of renderer exposure. No cloud noise, solar-disc
duplication, new pass, higher render resolution, density/geometry change or
per-frame PMREM regeneration is introduced. The existing 12-phase PMREM cache,
luminance-calibrated diffuse budget and ground radiance remain. Only this fixed
parameter profile is qualified by the native evidence below.

Selection requires `skyAtmosphere=scattering-v1` on the explicit,
non-embedded `island-720p60-v1` stream route. Absence keeps `gradient-v1`;
unknown, duplicate and unqualified requests fail closed. The candidate does
not silently change the default atmosphere.

## Visually found integration defect

Native73 revealed a hard gray band where distant ocean meets sky. The common
fog render target defaulted to normalized RGBA8 while its producer intentionally
renders untone-mapped linear radiance. The scattering profile's noon horizon
exceeds 1 in every channel, so normalized storage clips that color while the
visible sky retains it.

`FogConfig` now explicitly uses half-float storage. At 128x72, RGBA16F color
storage is 73,728 bytes versus RGBA8's 36,864 bytes: +36 KiB, excluding unchanged
depth/alignment/backend overhead. Target size, sample configuration, filtering,
identity and pass count are unchanged. No frame-cost claim follows from this
small declared allocation. This format correction applies to both atmospheres.

The real native74 fog texture reports `rgba16float`, 128x72x1 and one native
sample (Three target samples=0). Forty-eight screenshot brackets retain the
camera/projection/preparation checks. Coastal views no longer show the clipped
band. This combines source/formula, allocation and visible evidence; it is not
a GPU radiometry/readback measurement.

## Verification

- Shared regression: 1,004 tests / 77 files pass, including real TSL-DAG/CPU
  parity, capture isolation, night preservation, invalid vectors/parameters,
  route admission and half-float storage precision. CPU graph interpretation
  is not WGSL execution, texture filtering or visual acceptance.
- Shared/client/server typechecks, scoped ESLint and formatting pass.
  Shared/client builds pass; server built last with competitive manifest
  prefix `58d199c25423`. The shared package's unrelated `build:client` Vite
  command has no index.html entry and failed when invoked from that package;
  the actual shared library and client application build commands passed.
- Final capture harness: 56 checks pass after sources/builds stabilized.
  Observer03 changes only the required fog storage type from 1009 to 1016.
  Runner47 retains every camera, timing, source, equipment, screenshot and
  error gate; it adds passive atmosphere/native-format observations.
- Native74 source/image proof: 617 pins, 548 archived files / 56,933,825 bytes;
  42 frozen game paths; 24 PNGs / 21,965,552 bytes at 1280x720 DPR1;
  18 natural-daylight matched pairs, maximum phase delta .008827160937499912
  under the unchanged .01 limit. Maximum exposure delta .00004637947370023099.
- Both content censuses and live grass bindings pass (2,240 clumps /
  215,040 correction bytes). No page/GPU/cleanup errors. Owned Chrome,
  launcher and ports close. Overall remains false due to the unchanged
  five cow-model and fourteen dagger-fit errors.
- The six scenic images plus two equipped night views were visually reviewed.
  Clearer meadow sky and no hard coastal seam are narrow improvements.
  Terrain is still overly uniform, planting sparse, the ridge repetitive,
  service props isolated and campus platforms oversized/empty. Night skin
  remains cool/dark; this is not a dedicated daylight character-lighting review.
- Native73 remains failed: 16 scenic images completed before its seventeenth
  daylight-window check missed; no tolerance was widened. Its captured
  clipping defect is preserved, not repaired in its historical report.

Local evidence (parent workspace, not production-delivered assets):
`asset-studio/compact-render-feature-review01/{before74-root.json,verify74-root.mjs,after74-root-verification.json}`.
Native reports/images: `asset-studio/game-test-integration/compact-world-probe74/`.
Native74 report SHA-256:
`166e93ceb1c81b01eb5727829bc9c3ba6a16045b86bd99355e8ade1405620d7e`
(92,310,000 bytes).
Native73 report SHA-256:
`a4948285aba4f02e13e1ad85bcdab68dc6dca127d175c26d1664ecb8270fcf44`
(83,410,138 bytes).

## Required next work

Keep candidate/default promotion, clouds/sky composition, full-cycle motion,
dedicated daylight skin/metal checks, native GPU costs and presented-frame
measurements open. RAF intervals, counters and screenshot/CPU timings are not
substitutes. Grass fitting still measured a 5.5 ms longest slice here, so its
previous loading outliers are not resolved.

The next major art pass must address landform/shore silhouettes, layered
functional vegetation and ground materials, and coherent preparation/service
architecture around the single arena. One isolated shader improvement cannot
make the current layout an AAA scene.

## Primary references

- [Three SkyMesh documentation](https://threejs.org/docs/pages/SkyMesh.html)
  and [r186 implementation](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/objects/SkyMesh.js):
  scattering controls/equations, separate cloud cost and sun-disc handling.
- [Three RenderTarget documentation](https://threejs.org/docs/pages/RenderTarget.html):
  normalized unsigned-byte storage is the default unless a type is specified.
- [WebGPU timestamp queries](https://gpuweb.github.io/gpuweb/#timestamp-query):
  future GPU timing must correspond to actual submitted work. No GPU timing
  instrumentation or performance approval is introduced in this checkpoint.
