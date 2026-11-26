# Meadow material and island art direction — 2026-09-12

## Implemented checkpoint, not final environment approval

The compact meadow now has a dedicated fresh-green/dry-straw reflectance field.
It samples the existing repeatable noise texture at 0.006 repeats per meter,
independent of the original 0.0008 soil/cliff classification field. Both fields
are shared by the actual terrain shader, CPU grass fallback and native worker.
Dry meadow remains grass: it does not remove blades or reseed their placement.

The new linear-RGB endpoints are (0.8,1.25,0.65) and (1.85,1.25,1.2), blended over
noise 0.43–0.60. The existing ridge-shoulder tint still applies. Tests check the
strongest endpoints against every channel's maximum in the actual packed grass
diffuse: no reflectance channel exceeds one. Full soil paths and pond beds do
not inherit the meadow tint; normals, roughness and AO are unchanged.

Cost change: **one extra sample of the already allocated 256² noise texture**
in the compact fragment graph, plus one CPU sample per compact grass candidate.
There are still six 1024² packed surface maps and 14 PBR surface samples. There
are no new texture allocations, geometry, draw batches, passes, world placements,
density settings, LOD/horizon changes, lighting changes or resolution reductions.
This is not a zero-cost claim; GPU/frame-time qualification remains open.

## Art target and rejected experiments

The ImageGen skill and built-in image-generation tool produced a paintover of
the actual previous overview. Saved workspace artifacts:

- `asset-studio/island-art-direction01/island-target01.png`
- `asset-studio/island-art-direction01/TARGET_PROMPT.md` (complete final prompt)

The image is explicitly captioned **ART TARGET — NOT IN-GAME**. It guides warm
meadow/earth composition, layered low vegetation, fractured rocky ridges and
rocky coastal shallows; it is not an implemented asset, placement blueprint or
performance result. Keep one duel arena, all actual service approaches and
functional harvestable trees. The compact island replaces the large world;
the large island is not a preservation requirement.

The first experiment increased bare-soil coverage. Native
`plaza-ground-probe02` was too subtle visually and reduced installed grass from
2,275 to 1,862 clumps. Its report remains preserved with SHA-256
`ef50c262b89dbf06e4925fcb61c724614f9a9e196f78189fd45db599f1d43905`.
A second CPU experiment also changed the classification scale and failed 13
retained placement/contact/color tests (`shared-tests03.json`). These results
were not rewritten into new census goldens. Both classification changes were
rejected; only the independent meadow color treatment was retained.

## Verification

Evidence prefix: `asset-studio/island-art-direction01/`.

- `material-tests04.json`: 31/31 real material/texture/native-worker tests.
  Actual TSL graph has precisely three samples of the existing noise texture:
  classification, distortion and meadow. Legacy graph has no meadow sample.
  Independent arithmetic checks matching CPU/TSL tint, preserved physical layer
  support and full-soil overrides. Actual worker/main-thread color parity passes.
- `shared-tests04.json`: **1,158/1,158 tests across 84 files**, two workers.
  Original non-color worker-buffer hashes, historical terrain censuses, recorded
  blade-contact gaps and current natural-plaza census all pass unchanged.
  Current raw worker count remains 2,352; preparation fixture retains 186 clumps,
  42 in the former plaza. Those CPU fixture counts are not native drawn counts.
- Shared/server/client builds and all three typechecks pass. Scoped ESLint and
  Prettier checks pass. `preflight04.log`: all seven native-runner tests pass;
  existing startup, full-detail, failure, restoration and cleanup gates remain.

Final native run: `asset-studio/game-test-integration/plaza-ground-probe03/`.
Report SHA-256:
`6c2e24aa37b6b20290f48abce1dd870a167b11064356edf1bb7a9780b9ced6e5`.

- Headful Chrome, nonfallback Metal WebGPU, 1280×720, DPR1, MSAA4; same eight poses.
  Natural daylight phases 0.461706–0.489134, not a frozen clock. All eight art
  images directly inspected. Separate baseline/candidate simulation times and
  moving agents mean this is not a pixel-identical lighting/motion comparison.
- Exactly the same six installed grass populations as `plaza-ground-probe01`:
  (450,350):257; (350,250):344; (250,350):483; (350,350):187;
  (350,450):521; (450,450):483. Total 2,275, including 55 former-plaza roots,
  218,400 root-correction bytes. Zero excluded roots. Independent camera-frustum
  checks match the actual main render list at all 16 capture boundaries.
- All 48 functional trees and 52 shared dressing placements remain. Existing
  building cutaways, camera restoration/director resumption and owned browser,
  launcher and four-port cleanup pass. Zero page/GPU/cleanup errors.
- **Study passes; overall remains FAILED** on five missing-cow load errors and
  fourteen bronze-dagger missing-fit-metadata errors. Neither is suppressed.
- `native-root04.json` independently verifies all 675 current source pins,
  596 archived sources (59,154,823 bytes), 14 PNG hashes and ownership. Its
  `newShrubs:20` field describes the earlier planting baseline, not this pass.
  `matched-native04.json` confirms the eight poses/settings and exact installed
  grass populations against the previous committed material.

## Direct visual verdict and next tasks

This is a useful color-field foundation, **not AAA or finished meadow approval**.
The native overview now visibly separates fresh grass and dry meadow; matching
blade colors no longer depend on widening bare soil. But the patches are still
too exposed/airbrushed without convincing understory. Ridges remain synthetic
rounded forms, the coast is smooth, bushes are repetitive and cool-toned, and
the daylight/sky lacks the depth of the art target. These are substantial gaps.

1. Establish an actual GPU/frame baseline, then resolve the recorded grounding
   slice/contention issue before increasing grass/understory work. Capture real
   moving-agent/camera runs without screenshots inside measurement intervals.
2. Compose bounded low vegetation around the functional resource trees, paths
   and workstations. Share geometry/materials, use appropriate LOD and ground
   contact, and preserve gathering/navigation/visibility. Do not add a duplicate
   decorative forest or obscure silhouettes to hide unfinished terrain.
3. Replace soft ridge/coast presentation with designed fractured rock forms,
   scale hierarchy, believable ground-to-rock transitions and coastal shallows.
4. Qualify coordinated lighting, sky/clouds, water, shadow/contact and motion.
   Preserve complete avatar/equipment/animation and full-loop streaming checks.
   Apple M5/24GiB is available hardware, not low-end/scalability acceptance.

## Timing research and exact local support

[Three.js Backend documentation](https://threejs.org/docs/pages/Backend.html)
provides timestamp tracking and asynchronous query resolution. Inspection of
the installed r186 source confirms the renderer requests supported features,
but `trackTimestamp` defaults false. A read-only observation of the final native
device found `timestamp-query:true`, `trackTimestamp:false`; no timestamp or
renderer setting was changed in this art run.

The local `WebGPUTimestampQueryPool` resolves all queried passes but its scalar
return is the last renderer frame's aggregate, not a percentile distribution.
Group render **and compute** queries by the actual client frame; preserve sample
IDs, incomplete/overflow counts, bounded asynchronous readback and exact disposal.
Measure full client CPU work separately. GPU-pass sums do not measure browser
presentation, CPU/GPU idle gaps or end-to-end stream delivery.

[Chrome's timestamp-query documentation](https://developer.chrome.com/blog/new-in-webgpu-121)
explains optional feature detection and 100µs timestamp quantization. Do not
disable security/precision safeguards to claim an artificial benchmark gain.
Query support is useful instrumentation capability, not evidence that the
current art, whole-frame performance, delivery or launch gates have passed.
