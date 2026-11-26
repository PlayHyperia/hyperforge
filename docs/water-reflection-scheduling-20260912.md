# Water reflection scheduling — 2026-09-12

## Qualified change

The existing streaming profile already sets realtime water reflections off.
Previously that set the shader blend to zero but still rendered an invisible
reflection and another sun-shadow map. WaterSystem now skips the reflector's
native update while disabled. No profile, geometry, shader blend, resolution,
shadow quality, foliage density or lighting setting was reduced.

The reflector remains registered with Three's native update policy. Its
per-instance `getUpdateBeforeType()` returns `none` only while disabled, so
enabling reflections after initial shader compilation works without replacing
the node or recompiling the material. Native drawing is not overridden.
This follows the actual r186 NodeBuilder/NodeFrame dispatch, also documented in
[Node](https://threejs.org/docs/pages/Node.html#Node.getUpdateBeforeType) and
[NodeFrame](https://threejs.org/docs/pages/NodeFrame.html#NodeFrame.updateBeforeNode).

## Native result

Headful Chrome 152, nonfallback Metal WebGPU, Apple M5/24GiB; unchanged
`island-720p60-v1`: 1280x720, DPR1, MSAA4, 4096² sun map. Same eight camera poses,
52 dressing placements, 48 functional trees and six grass populations totaling
2,275 clumps. Two diagnostic agents and existing NPCs; no stream encoding,
betting or keeper load. Natural daylight and actors keep advancing.

| Campus overview metric          | Control probe04 | Candidate probe09 |
| ------------------------------- | --------------: | ----------------: |
| Render passes per tick          |               6 |                 4 |
| Median draw calls across passes |           1,273 |               643 |
| Median submitted triangles      |       5,408,575 |         2,739,729 |
| CPU tick elapsed, median / p95  |   19.8 / 23.8ms |     10.9 / 16.6ms |
| GPU pass sum, median / p95      | 18.15 / 23.53ms |   14.88 / 17.43ms |

These are separate instrumented runs, not deterministic identical-actor A/B
benchmarks. CPU and GPU overlap; do not add them. Pass sums are not complete GPU
wall-frame time, and client tick intervals are not browser-presented FPS.
The meadow had no visible reflection pass to remove: its median CPU changed
9.6→10.1ms and GPU sum 15.79→16.78ms. Probe09 also contains an 80.4ms meadow CPU
spike. Smooth motion, high-load and broad-device performance are **not accepted**.

The separate native preference exercise verifies off→on→off. It starts with no
reflection render target, enabling produces one real 640x360 reflection plus
two native sun passes (six total), and disabling returns to one sun/four total.
The same node/base identities and original zero blend are restored. One cached
target is retained for re-enabling, rather than repeatedly allocated/disposed.
The enabled-reflection visual/motion pass and shared-shadow optimization remain
separate work; this is not approval of all water quality or reflection modes.

## Verification and evidence

- 3/3 focused real-node tests; 1,160/1,160 tests across 84 files, two workers.
  New unit cases use real World, WaterSystem, reflector and NodeFrame objects;
  they do not simulate a GPU. Native preference exercise supplies dispatch proof.
- Shared/client/server typechecks and builds; scoped ESLint/Prettier; 13/13 native
  preflights. Existing caps/readiness/error checks were retained.
- Independent verifier checks 675 current pins, 596 archives, 14 PNG hashes, actual
  render work, CPU profile files, every query/frame association, toggle state,
  scene/camera/grass ownership and cleanup. All eight native images inspected;
  no visible regression identified. Moving actors/daylight prevent pixel identity.
- Matched control/candidate camera settings, placements and grass populations
  are independently equal at all 16 image boundaries. Root verification log:
  `asset-studio/gpu-frame-profile01/native-root09.log`.
- **Study passes, overall fails** the unchanged 19 cow/dagger content errors.
  Zero page/GPU/cleanup errors; owned browser, launcher and all four ports close.

Final report: `asset-studio/game-test-integration/gpu-frame-probe09/report.json`,
SHA-256 `90755e6d1f42c5f044bb9f5504cb271044c65ef402e57294d7e972558c941303`.
[Machine-readable evidence](evidence/water-reflection-scheduling-20260912.json)
retains unrounded metrics, hashes, matched-view checks and native toggle receipts.
Local full reports retain raw CPU/GPU ledgers; the JSON summary is not a replacement.

Failed attempts remain preserved: probe05 hit real boot/cursor readiness;
probe06/07 rejected two shadows and probe07 exposed the disabled-reflection
cause; probe08 passed image/query gates but its added toggle selection exceeded
the existing 16-sample image ledger. Probe09 selects the toggle camera separately,
without raising that cap or removing any required image. The unqualified
single-shadow candidate was removed from runtime and saved locally as
`asset-studio/gpu-frame-profile01/unqualified-sun-reuse-candidate.patch`.
Its unit tests passed, but that did not qualify it for promotion.

## Still required for the visual target

This is a rendering-efficiency fix, **not a visible AAA art upgrade**. Continue
with authored fractured ridge/coast forms, convincing rock/soil/grass transitions,
varied bounded understory around functional trees, shoreline/shallows, and
coordinated lighting/sky/water/contact. Retain animation, equipment, camera,
navigation, end-to-end stream and full-load/presented-frame tests. Heavy provisional
armor and remaining CPU spikes still constrain scalability. Advanced effects
must earn their cost in this scene; do not increase density blindly or claim
that a WebGPU demonstration establishes our production performance.
