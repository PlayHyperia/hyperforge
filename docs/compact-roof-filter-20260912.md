# Compact lodge roof filtering

The compact lodge now opts into `shingleFiltering: "footprint-v1"`. The original
roof geometry, colors, material scale, roughness and shadows remain unchanged.
Other building materials retain their original graph; invalid opt-ins reject.

The previous hard procedural threshold produced broken dark dashes where gaps
were smaller than a pixel. The new TSL graph measures continuous UV derivatives
before cell wrapping, analytically integrates a bounded two-by-two neighborhood,
and blends toward the correlated statistical mean at wider footprints. There is
no added texture, draw or render pass. That does **not** establish zero GPU cost:
the expanded graph has 1,088 nodes, including four shared asin and twenty sin
nodes. Derivative-box filtering is not an exact pixel-parallelogram integral.

## Verification and selected evidence

- 903 shared tests in 73 files; 139 procgen tests in eight files; four package
  typechecks; scoped lint/format and client/shared then server builds pass.
- Tests cover actual TSL graphs, double and per-operation float32 evaluation,
  dense original-pattern integration, seams, negative/tiny/large UVs, legacy
  behavior and explicit admission. These are not GPU execution tests.
- Native64 uses actual headful Apple Metal WebGPU, no fallback, 1280×720 at DPR1.
  All 18 exact-camera daylight pairs against native62 pass: maximum phase
  delta 0.0048018764 and exposure delta 0.0000349109. Natural forward waits total
  2.603 seconds; no clock/light/camera edits or relaxed comparison limits.
- Root and independent review verify all 582 source pins, 513 archives,
  24 PNGs, 48 fog brackets and both island/lodge/presentation censuses.
  Direct image review confirms coherent roof rows replacing broken dashes.
- Native64 report SHA256:
  `21daec64e813aa350edd43d4d4aac28fa4184a0c7c784c7d475fc9867db9bdd0`.
  Local evidence: `asset-studio/game-test-integration/compact-world-probe64`
  in the parent workspace. It is not bundled in the game repository.

Native63 is retained as a failed comparison: one phase boundary exceeded .01.
Native64's capture timing repair passed all 83 capture tests before the rerun.
Neither result is silently relabeled: native64 study passes, but the overall
run remains failed on fourteen dagger-fit messages and five cow-load messages.
No page/GPU/cleanup errors occurred; the owned browser/services were retired.

This selects a targeted visual correction, not whole-scene AAA, motion,
sustained FPS, thermal, GPU-time or launch approval. Broad empty lawn, uniform
scarp, hard-platform composition, foliage lighting and content blockers remain
open in the launch checklist.
