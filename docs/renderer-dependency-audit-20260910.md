# Renderer and audiovisual dependency qualification

## Decision

Qualify a deliberate Three.js upgrade before making substantial new lighting and
post-processing changes. The installed renderer is behind current stable, and
newer WebGPU fixes are relevant to this project. This is not a recommendation to
update every dependency together: a renderer upgrade cannot replace coherent
world composition, fitted equipment, good animation or reliable resource behavior.
No package manifest, lockfile or installed dependency was changed by this audit.

The current build is a valuable comparison baseline. Retain its matched captures
and exact source pins, isolate dependency changes in their own verified checkpoint,
and require actual WebGPU gameplay and broadcast evidence before promotion.
The compact island still uses one intended arena and its existing choppable
resource trees as the complete tree population; dependency changes do not alter
those gameplay/art requirements.

## Installed versions and current releases

These are actual package resolutions from the implementation's root, shared,
client and server contexts, checked September 10, 2026 at23:39UTC. They are not
inferred from requested semver ranges. Latest versions and publication dates come
from each package's primary npm registry metadata. They describe available
releases, not a certified compatible set.

| Component                     | Installed                | Current stable candidate | Recommendation                                                                                                     |
| ----------------------------- | ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Three.js                      | 0.183.2                  | 0.186.0, September8      | High-priority isolated WebGPU qualification                                                                        |
| Three type declarations       | 0.183.1                  | 0.185.4, August4         | Resolve r186 declaration/API compatibility explicitly; a matching r186 release was not available in the latest tag |
| Pixiv three-vrm               | 3.4.3                    | 3.5.5, July9             | Qualify with the renderer, canonical VRM and all equipment/animation paths                                         |
| glTF Transform core/functions | 4.4.2                    | 4.5.0, September1        | Separate export-toolchain experiment with exact output/decoder comparisons                                         |
| meshoptimizer                 | 0.22.0 direct resolution | 1.2.0, June30            | Major version gap; inspect encoder/decoder API and emitted formats before changing                                 |
| hls.js                        | 1.6.17                   | 1.7.2, September2        | Separate playback/recovery and decoded A/V continuity qualification                                                |
| livekit-client                | 2.21.0                   | 2.22.3, September7       | Pair with connection/reconnect and browser-mix broadcast tests                                                     |
| livekit-server-sdk            | 2.17.0                   | 2.19.0, September9       | Separate service/API compatibility check; no custody or settlement changes                                         |
| Vite                          | 8.2.0                    | 8.3.0, September10       | Fresh release; build/PWA/worker/dev-server qualification, not a visual-quality prerequisite                        |
| TypeScript                    | 6.0.3                    | 7.0.2, July8             | Defer unrelated major toolchain migration until renderer changes are isolated                                      |

Primary version records: [Three](https://registry.npmjs.org/three),
[types](https://registry.npmjs.org/%40types%2Fthree),
[VRM](https://registry.npmjs.org/%40pixiv%2Fthree-vrm),
[glTF core](https://registry.npmjs.org/%40gltf-transform%2Fcore),
[glTF functions](https://registry.npmjs.org/%40gltf-transform%2Ffunctions),
[Meshopt](https://registry.npmjs.org/meshoptimizer),
[HLS](https://registry.npmjs.org/hls.js),
[LiveKit client](https://registry.npmjs.org/livekit-client),
[LiveKit server](https://registry.npmjs.org/livekit-server-sdk),
[Vite](https://registry.npmjs.org/vite),
[TypeScript](https://registry.npmjs.org/typescript).

Root overrides explicitly force Three0.183.2 and VRM3.4.3 despite shared/client
declarations requesting Three0.184.0 and VRM3.5.3. Correct declarations, overrides,
patch key and lockfile as one coherent migration. Root/server and shared/client
resolve Three through different physical package paths; verify the actual
bundled module identity rather than assuming equal version strings prove a
singleton or that different paths alone prove a runtime defect. Type-only packages
need direct package metadata inspection; failed runtime resolution is not proof
that their declarations are absent.

## Concrete upgrade value and migration risks

Three r186 contains WebGPU material-state, timestamp, batching and resource-lifetime
fixes. Its release notes also include changes to lighting and PMREM generation,
so matching old screenshots bit-for-bit is not the only acceptance criterion:
explain changed illumination while requiring consistent materials, silhouettes
and performance. The release is only two days old at this audit. [1]

The most directly relevant fix is the addition of missing material properties
to WebGPU render-state checks. The r186 source includes polygonOffset, factor
and units in state/cache handling. This addresses the omission implicated by
the hospital-floor investigation, but no r186 game run has yet shown that the
green stripes disappear. Treat it as a strong diagnostic candidate, not a
verified causal remedy. [2]

The local Three patch clears completed render-pass and command-encoder references
after submission. Official r186 source and both unminified WebGPU bundles still
lack the equivalent cleanup in finishRender; framebuffer copy still tests the
stored pass and can reuse its encoder. **Rebase and regression-test this patch;
do not silently discard it.** A fresh successful install does not exercise the
compileAsync/framebuffer-copy lifecycle that motivated the patch. [3]

Several explicit migration checks apply. WebGPU no longer supports
PCFSoftShadowMap; RendererFactory and ClientGraphics currently select it and must
move to the supported PCFShadowMap path. r186 normal render/compile entry points
warn and substitute that filter, rather than necessarily crashing immediately.
Environment/background rotation changed
after r183, so an HDR sun direction must be rechecked. Premultiplied-alpha changes
require testing the opaque game canvas and any composited stream overlays.
FBX axis handling changed; validate imported animation orientation. Object3D
disposal now has a base lifecycle, and renderer disposal has become asynchronous;
inspect application teardown and subclass ownership, not only compilation.
GTAO and geometry utilities also have changed APIs if adopted. [1][4]

Private pipeline diagnostics need a new immutable observer version. r186 render
lists are keyed by scene, camera and lighting, while the old observer reads the
two-key map; the render-object cache field also changed from chainMaps to
_chainMaps. Otherwise an unavailable diagnostic could be mistaken for evidence
that material pipelines are fixed. Inspect existing caches without creating
entries, and retain all historical observer/capture bytes. [10]

VRM's broad peer range, three>=0.137, is not evidence that the project's custom
WebGPU materials, humanoid normalization, hand sockets, spring bones and animation
retargeting work correctly with r186. The3.5.5 release itself lists development
dependency maintenance, not a promise to repair avatar appearance. Select a
version based on tested compatibility and relevant intervening fixes. [5]

Existing r183 already supports the WebGPU/TSL foundation, environment-map
prefiltering and compressed-asset integration paths needed for a substantial
quality increase. The upgrade should improve reliability and available options;
it should not become an excuse to postpone composition, lighting calibration or
the agent resource loop.

## Performance evidence, not package-age assumptions

The installed Info implementation exposes geometry/texture counts, not total
resident bytes. Current online documentation lists richer allocation counters;
those fields must not be read as if they exist in0.183.2. Even newer allocation
accounting needs clear scope: driver overhead, transient scratch resources and
video encoding are not automatically a complete application-memory measurement.
Preserve explicit geometry and texture estimates alongside measured counters. [6]

The installed renderer has opt-in timestamp tracking and asynchronous resolution.
WebGPU timestamp queries require adapter support; Chrome documents100microsecond
quantization. Feature-detect availability and report unavailable samples honestly.
Do not label JavaScript submission duration as GPU execution time or disable
browser security to manufacture precision. [7]

Bound the number of unresolved queries and retire results outside the critical
render path. Record render/compute coverage and skipped samples. Upstream r186
specifically fixes query-limit handling when timestamp results are not resolved
often enough, making both overflow and prolonged observation relevant tests. [8]

For a60Hz target,16.67ms is the whole display interval, not a budget available
independently to JavaScript, GPU work and encoding. Frame pacing matters as much
as average FPS. Browser rendering guidance describes the shared frame pipeline;
the actual game's GPU and stream workload must still be measured. [9]

Proposed acceptance is matched A/B runs at identical resolution, DPR, camera
path, population, visual settings and thermal conditions, recording p50/p95/p99
frame intervals and hitches, CPU work, available GPU timings, draw/triangle counts,
resource allocations, cold load and warm revisit. Include preparation travel,
tree harvesting/depletion/regrowth, bank/equipment changes, combat, water/shadows,
day/night transitions, reconnect and scene teardown/recreation. Run with actual
stream encoding as well as without it. The current Mac is a development baseline;
minimum supported hardware and final population limits remain explicit launch
decisions, not implied by a passing static capture.

## Promotion checklist

- [ ] Preserve the current game/asset revisions and unmodified before captures.
- [ ] Select exact Three/VRM/type versions, reconcile declarations and overrides,
      and rebase the local render-pass lifecycle patch with a focused regression.
- [ ] Resolve WebGPU shadow migration, disposal contracts and loader/rotation
      changes without broad casts or weakening tests to conceal incompatible APIs.
- [ ] Use Bun for a reproducible install; inspect lockfile scope, package/license
      and security changes. Verify all relevant runtime and bundled module identities.
- [ ] Pass source/type/build/lint checks and actual headful Chrome/Metal WebGPU
      startup, material compilation, VRM/equipment/animation and resource lifecycle.
- [ ] Compare the exact hospital-depth scenario, pond/shore, trees and foliage,
      skin/armor color, sky/environment alignment and near/far shadow behavior.
- [ ] Measure matched CPU/GPU/loading/memory and decoded stream A/V behavior.
      Preserve known failures as failures; never use an upgraded version as approval.
- [ ] Commit/push a scoped checkpoint with identity, secret scan and remote-ref
      verification. Keep toolchain/export and stream SDK changes independently
      attributable. No merge, production deployment or blanket dependency update.

## Sources

All version metadata and live pages were checked September10,2026. Version-pinned
source is distinguished from rolling documentation. Recommendations above are
project-specific engineering judgments; no target-device benchmark was performed
by this audit.

1. Three.js contributors, [r186 release](https://github.com/mrdoob/three.js/releases/tag/r186), September8,2026.
2. Mugen87 / Three.js, [WebGPURenderer: Add missing material properties to state checks, PR34406](https://github.com/mrdoob/three.js/pull/34406), merged August31,2026.
3. Three.js contributors, [r186 WebGPUBackend.js](https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/webgpu/WebGPUBackend.js), release-pinned source; compared with local patches/three@0.183.2.patch.
4. Three.js contributors, [Migration Guide,183→186](https://github.com/mrdoob/three.js/wiki/Migration-Guide), rolling documentation checked September10,2026.
5. Pixiv, [three-vrm v3.5.5](https://github.com/pixiv/three-vrm/releases/tag/v3.5.5), July9,2026; peer range from primary npm metadata linked above.
6. Three.js contributors, [Info documentation](https://threejs.org/docs/pages/Info.html), rolling page; compared with installed src/renderers/common/Info.js0.183.2.
7. François Beaufort / Chrome for Developers, [What's New in WebGPU, Chrome121](https://developer.chrome.com/blog/new-in-webgpu-121), January2024.
8. Sunag / Three.js, [WebGPURenderer: Fix timestamp query limits, PR34236](https://github.com/mrdoob/three.js/pull/34236), merged August14,2026.
9. Google/web.dev, [Rendering performance](https://web.dev/articles/rendering-performance), current guidance checked September10,2026.
10. Three.js contributors, r186 [RenderLists](https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/common/RenderLists.js) and [RenderObjects](https://raw.githubusercontent.com/mrdoob/three.js/r186/src/renderers/common/RenderObjects.js), release-pinned source.
