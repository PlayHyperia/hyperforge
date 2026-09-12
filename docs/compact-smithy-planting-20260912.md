# Compact smithy planting — 2026-09-12

## Scope and verdict

Intermediate environment-art work, not AAA, frame-time, gameplay, streaming or launch acceptance.
Twenty low shrubs now form unequal planted flanks around the existing open smithy.
All 48 functional resource trees, stations/NPCs, 11 paths, court geometry, terrain,
water, lighting, collision and camera systems are unchanged.

The manifest contains 12 west-bed and eight east-bed plants at varied scale/yaw.
The full crown, not merely the root point, must clear the analytical paths and actual
bilinear road-mask support, station working space, NPCs and tree-harvesting approaches.
Two initial eastern plants failed these checks and were repositioned. No path was
moved or test clearance relaxed to make the planting fit.

The new optional `compactServicePlanting` field is validated at content admission:
exact JSON fields, supported profile/court, two distinct beds, finite meter positions,
bounded complete crowns, scales/yaws and a 24-plant limit. It is detached and frozen.
The full world content identity is now
`674913b9611955f696b99645aba80a698f01ae7722ad345ea9a8fa45f50d6a9b`.
Game and independent asset-manifest changes must travel together.

## Rendering and scalability

Reuse the existing `pond_bush.glb` and actual pond dressing owner. The combined
52 placements remain below the original 64-instance ceiling and use the same five
instance batches, five private palette materials and borrowed cached geometry/maps.
The renderer still grounds roots against retained rendered terrain triangles and
does not upload matrices again until a relevant terrain revision changes.

Additional source geometry submitted when the bush batch renders is 27,920 triangles
per pass; additional instance-matrix storage is 1,280 bytes. These are geometry/buffer
counts, **not GPU timings or measured frame-rate improvements**. Combining the beds
with the pond broadens the bush batch's culling bounds; the performance effect still
needs measurement. No extra rendering pass, texture, camera-distance thinning,
resolution reduction or graphics-profile change is introduced.

This follows Three.js's [shared-geometry/material instancing contract](https://threejs.org/docs/pages/InstancedMesh.html).
The existing renderer recomputes full instance bounds after changed placements and
disposes only its own buffers/materials; cached geometry and textures remain borrowed.
No new source assets or license claims are introduced.

Current Three.js also offers [screen-space indirect lighting](https://threejs.org/docs/pages/SSGINode.html)
and [temporal reprojection antialiasing](https://threejs.org/docs/pages/TRAANode.html).
Those capabilities are not free upgrades: SSGI has explicit per-pixel sample costs
and temporal artifact risks; TRAA requires velocity input and disabled MSAA. They
remain separate measured candidates, not changes to this four-sample native profile.

## Verification

Evidence below is in the parent workspace's `asset-studio/compact-smithy-court01/`.

- Focused placement/real-geometry tests: 13/13, `planting-tests03.json`.
- Full 84-file regression suite: 1,151/1,151, `planting-shared-tests05.json`.
  Includes real PhysX/service/resource/BFS checks and genuine canonical GLB geometry.
- Preserve tests01/02's path intersections and shared04's three historical-fixture
  failures. Historical reconstruction now removes the new field; original historical
  hashes and census expectations are unchanged. No grass contention failure occurred
  in this final two-worker run; the previously recorded intermittent issue is still open.
- Shared/client/server TypeScript and production builds pass, with logs named
  `planting-types-{shared,client,server}01.log` and
  `planting-build-{shared,client,server}01.log`.
  Scoped ESLint, Prettier and diff checks pass.
- Six native-capture preflight checks pass (`planting-preflight05.log`), including
  unchanged startup/error/cleanup operations, unchanged non-planting manifest data,
  exact content admission, source-pinning bounds, the 14-image fog observer and
  each actual canonical GLB's mapped/unmapped material contract.
- Native probe01 stopped before its art study on the stale manifest pin. It is retained
  with its old 24-image and launcher-exit cleanup failures. Owned Chrome closed and
  all four ports were free; a separate process check found no surviving owned launcher.
- Probe02 exposed a capture-only assumption that every pond material had a color
  texture. The original reed GLB is untextured; the other four have color maps,
  and boulder/fern/bush have normal maps. Those exact per-model expectations are
  now checked. No game material or source asset was altered. Probe02's missing
  images remain a failed gate; its camera restored and owned browser/launcher closed.
- Native probe03 completed all eight art views plus six baseline images on real
  nonfallback Metal WebGPU, 1280×720/DPR1/MSAA4. No page/GPU/cleanup errors; exact
  camera restoration, original director resumption and owned process/port shutdown.
  Study passes; the overall report still fails on the 19 existing cow/dagger errors.
- Root independently checks all 675 current source pins, 596 archives (59,125,900
  bytes), 14 image hashes, every bush X/Z/yaw/scale matrix, stable geometry/material/
  map identities across all image boundaries and the complete 52-instance receipt.
  `planting-root-verification03.json` retains those results; verification code is
  `game-test-integration/service-planting01/verify-native-root.mjs`.
- Report: `game-test-integration/service-planting-probe03/report.json`, SHA-256
  `0b98abf29913919f7a1dd06234b70647d50873194c6c4fb763e15cbc1daafffe`.
  This is a controlled two-agent graphics review, not the full keeper/betting/HLS loop.

## Direct image review

All eight new art images were inspected. The smithy-front, smithy-west and meadow
views now have planted boundaries with visible gaps and open service frontage. In
those stills the shrubs sit on the terrain without obvious floating roots. The
anvil view retains the previously identified foreground-beam occlusion; the bank
view retains the lodge-roof obstruction. No claim of perfect all-angle fitting,
animation or antialiasing follows from these still images.

The added planting is a useful local composition change, not the requested finished
quality. The full-island view remains dominated by a uniform lawn, exposed rectangular
arena courts and widely separated props. The shrubs are visually repetitive and cool;
they need richer ground/plant layering, not just more copies. The ridge still has
rounded, mechanically terraced forms and the bay has an abrupt cliff-to-water edge.
Those are explicit open art issues, not accepted scenery.

## Next art gates

The high smithy beams still cross the diagnostic preparation view after its roof
fades. The bank roof occupies too much of the older bank-camera foreground. Fix
visibility while preserving collision, shadow ownership and complete outside views.
The larger visual gaps remain layered ground variation, shoreline transitions,
rock silhouettes, composition around functional trees, animation/contact quality
and whole-game-frame CPU/GPU/memory qualification on explicit target hardware.
