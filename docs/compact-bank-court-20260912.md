# Compact bank/service-court checkpoint — 2026-09-12

## Verdict

Intermediate composition checkpoint, **not visual-final, performance, stream or launch approval**.
The service buildings now form a recognizable bank/workshop cluster and the two oversized
platforms are substantially smaller. Native82 still shows a flat, sparsely dressed lawn,
rounded rock knolls, an unfinished shoreline and weak contact lighting. Those are substantive
art/rendering tasks, not things that a successful test suite makes acceptable.

The unchanged diagnostic bank camera now has a large lodge roof in its left foreground.
This is a new framing defect to resolve; the chest remains visible. The real cinematic
camera has its own environment/terrain line-of-sight solver, so this static diagnostic
does not establish that every production bank shot is broken—or that production is clear.
The lodge has no camera cutaway; the existing smithy cutaway still leaves lower beams in
some preparation views. Actual animated bank/preparation coverage remains a required gate.

## Implemented

- Arrival court: 40×25 m → 18×16 m. Recovery court: 28×23 m → 12×12 m.
  Combined hardscape area: 1,644 → 432 m² (73.7% less). This is geometry area,
  **not a measured GPU saving**. One 20×24 m combat ring and existing return marks remain.
- Same seeded, five-mesh lodge moved from (398,370), rotation 0 to (350,328), rotation π.
  It faces the existing bank chest and shares the existing service plaza grade.
  No station, NPC or resource-tree identity/position was moved.
- Validate the entire rotated roof/steps envelope against the actual bank plaza support.
  Pose is admitted through full world-content identity; recipe, geometry and collision
  openings are unchanged. The lodge remains 1,332 triangles / 168,376 geometry bytes.
- Reroute the existing bank–workshop and bank–arrival surface paths around the west/south
  of the lodge. Check smoothed path width, blend and bilinear mask support against actual
  lodge geometry, smithy posts and every resource tree's all-LOD canopy.
  These are surface masks, not new navigation authority or remote-banking access.
- Replace the oversized bright recovery cross with a small, non-emissive mineral-teal
  ring/diamond floor inlay. Same two mesh objects; no new collider.
- Keep historical compact v4/v5 fixtures explicit. They are test history, not a retained
  large island or an alternate world to ship. Active safe-zone bounds/grade remain unchanged.

Game and independent asset manifests must travel together. Active world content identity:
`b5b78d802479bdbe361093df855159260525b225a8060b3b40fecea189155d74`.

## Verification and retained failures

Evidence paths below are relative to the parent workspace's `asset-studio/`.

- Final uncontended shared run: **1,137/1,137 tests, 83 files**,
  `compact-smithy-court01/bank-hub-shared-tests11.json`.
  Includes real generated-mesh/PhysX openings over three lifetimes, complete floor support,
  service/tree/path exclusions and existing resource access/return-mark checks.
- Shared/client/server type checks; scoped lint/formatting; shared/client/server production
  builds all pass. Final build receipts: `bank-build-{shared,client,server}02.log`.
  Capture preflight: 18/18, `bank-harness-tests06.log`.
- Intermediate runs are retained. They caught real tree-canopy, lodge-corner and smithy-post
  path intersections before the final route. Historical fixtures were corrected to reconstruct
  their original inputs; original content hashes were not simply updated to bless new content.
- Run10 had one grass grounding test failure while builds ran concurrently. Run11 passed
  without competing builds and without changing that assertion. The cause is **not proven**;
  investigate under load rather than claiming the scheduling/grounding issue is fixed.
- Native81 stopped on a stale hardcoded lodge pose in the capture startup validator. The
  game reported the correct new pose. Its immutable report/archive is retained; a preflight
  now accepts the actual new startup receipt and rejects the stale pose/missing collision.
  Its expected missing-screenshot cleanup gate failed; owned browser/launcher/ports closed.
- Native82: real nonfallback WebGPU, 1280×720 at DPR1, 24 hashed PNGs.
  All 18 camera/daylight pairs match native64 and direct native80 under the unchanged 0.01
  phase threshold. Maximum phase deltas: 0.00791821 / 0.00815082 respectively.
- Root independently verified **659 source pins, 590 source archives, 52 frozen game files**,
  all image hashes, 48 fog screenshot boundaries, 36 smithy-cutaway boundaries, six compiled
  filtered-timber pipeline observations and both actual 48-tree scene censuses.
  Live grass: 2,212 clumps, 212,352 correction bytes; grounding qualification passes.
- Native82 page/GPU/cleanup errors: zero. Owned browser and launcher closed; all four owned
  ports free. This does not authorize closing any unrelated user browser or app.
- Native82 study passes; **overall fails** on 19 retained content errors: five cow-model/404
  errors and fourteen dagger-fit metadata errors. No hidden error suppression.
- Independent verifier and result: `compact-smithy-court01/verify82-root.mjs`,
  `after82-root-verification.json`.
  Report: `game-test-integration/compact-world-probe82/report.json`,
  SHA-256 `08439838f3f3ddee34c2602d77cbb96a2d90577241c39d3e0d19934b44e05a09`.
  Native81 SHA-256:
  `6f042c2cc50d5ef895bc19d9cbb481077cd6194a2612e58ec678539b6b56f35c`.

The capture is a controlled two-agent graphics study, not the full betting/keeper/HLS
production loop. It is explicitly performance-ineligible: image and lifecycle evidence
does not establish presented FPS, GPU milliseconds, animation quality or a long soak.

## Rendering direction informed by current Three.js/WebGPU research

The installed Three.js is r186. A library bump is not a substitute for art direction or
measurement; available capabilities already include the following:

- [GTAO](https://threejs.org/docs/pages/GTAONode.html) can add small-scale contact grounding.
  Its indirect-light context matters: do not simply darken the entire final image, sky,
  highlights and direct lighting. Compare full/half-resolution AO at fixed canvas quality,
  with normals/depth faithful to animated skin, foliage alpha and wind.
- [SSGI](https://threejs.org/docs/pages/SSGINode.html) offers screen-space indirect light.
  Temporal filtering can trade samples for history dependence and ghosting. It is a later
  measured candidate, not free lighting or complete scene-independent global illumination.
- [RenderPipeline](https://threejs.org/docs/pages/RenderPipeline.html) provides the WebGPU
  effect graph. Keep tone mapping/output conversion single-owned; qualify neutral-control
  parity, MSAA/alpha behavior, resizing, failures and disposal before integrating effects.
- [BatchedMesh](https://threejs.org/docs/pages/BatchedMesh.html) and instancing are appropriate
  for repeated compatible scenery. Batching does not excuse excessive overdraw, texture
  residency, shadows or high-detail geometry at unhelpful screen sizes.
- The [renderer](https://threejs.org/docs/pages/Renderer.html) supports precompilation and
  GPU work; actual device profiling must establish the budget. A showcase particle count
  from another scene is not a capacity estimate for this game.

The existing untracked contact-AO experiment was inspected, not integrated or committed
with this checkpoint. No global graphics setting, dynamic-resolution default, texture
budget, AO/GI effect or fallback was silently changed.

## Next acceptance gates

- [ ] Correct bank roof/near-camera obstruction and smithy low-beam coverage; preserve
      physical collision/shadows and review smooth transitions with the real moving camera.
- [ ] Connect the recovery court visually and navigably; add proportionate perimeter
      details and worn service-ground transitions without moving authoritative return marks.
- [ ] Establish and measure contact lighting/indirect-light candidates with neutral controls.
      Require actual GPU timestamps and presented-frame statistics, not JS render-call time.
- [ ] Replace the empty-lawn composition with grounded, clustered small foliage, rock
      accents and richer terrain variation. Functional choppable trees remain the tree
      population. Preserve approach clearances and gathering/depletion/respawn behavior.
- [ ] Improve western landforms, shoreline/bank materials, shallow water and sky/horizon
      composition; verify close, gameplay and stream distances in motion.
- [ ] Resolve missing cow and dagger-fit content errors; qualify the full agent preparation,
      combat, betting and streaming loop with multiple agents and sustained load.
- [ ] Investigate the retained grass grounding test failure under controlled CPU contention.
- [ ] Pass visual, temporal, GPU/frame-time, memory/lifecycle and long-duration gates before
      calling any candidate production-ready. Overall AAA-quality approval remains open.

