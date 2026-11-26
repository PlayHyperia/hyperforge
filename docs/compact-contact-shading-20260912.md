# Compact-island contact shading experiment

Status: researched implementation proposal, not enabled or visually qualified.
The installed renderer is already Three r186. A broad dependency upgrade is
not the next graphics improvement; use its existing native WebGPU capabilities
and measure them against the same scene, camera and resolution.

## Wider graphics headroom

Three also provides screen-space indirect illumination and reflections, but
their existence is not evidence that enabling them improves this game. SSGI's
sampling and temporal/denoising choices have explicit cost and motion tradeoffs.
[Official SSGI documentation](https://threejs.org/docs/pages/SSGINode.html).
SSR needs scene depth/normals and appropriate material/environment inputs;
ray-march quality and effect resolution change its cost.
[Official SSR documentation](https://threejs.org/docs/pages/SSRNode.html).
Both are later, separately measured experiments, not bundled with contact AO.

Richer authored scenery should first reuse the project's existing instances,
LODs and batches. BatchedMesh supports different geometry/transforms sharing
materials and per-object culling; that is useful headroom, not an automatic
speed guarantee for this renderer/workload.
[Official batching documentation](https://threejs.org/docs/pages/BatchedMesh.html).
Do not replace already-batched resource trees merely to claim this feature.

## First visible target

Improve grounded contact around the lodge plinth, steps, equipment and foliage
without flattening sunlight, turning pale skin gray or making interiors black.
This is one component of the art pass. It cannot repair repetitive terrain,
sparse composition, incorrect materials, floating geometry or missing assets.

The native GTAO addon supports a normal/depth prepass feeding ambient occlusion
into the beauty pass through `builtinAOContext`. Half-resolution AO is an
available quality/cost control; temporal filtering requires TRAA and introduces
history artifacts. Keep temporal filtering off for the first comparison.
[Official GTAO documentation](https://threejs.org/docs/pages/GTAONode.html).

The installed `ContextNode.js` multiplies existing authored AO and skips
transparent materials. `PhysicalLightingModel.js` applies it to indirect
diffuse/specular and related clearcoat/sheen, not direct light or emission.
Therefore apply the native PBR context, not a dark multiplier after tone mapping.

## Integration boundaries

- `ClientGraphics.ts` creates its composer during initialization. A preference
  toggle alone does not instantiate it.
- `PostProcessingFactory.ts` currently constructs hash blur, tone mapping, LUT
  and outline nodes. A zero blur blend still leaves that graph present. Build
  an explicit AO-only experiment rather than enabling unrelated effects.
- Existing stream render profiles require direct rendering. Admit a separately
  named/versioned experiment; never relabel it as the unchanged baseline.
- Use the persistent renderer and retain beauty resolution, DPR, four-sample
  MSAA, camera, sun/shadows, environment and exposure. Apply output conversion
  exactly once. Preserve existing LUT/outline behavior outside the experiment.
- The normal/depth prepass must retain actual skinning, wind, alpha cutout and
  dissolve behavior. A blanket override material is not acceptable. Exclude
  transparent water; reflection-enabled views require their own camera-context
  qualification because reflection rendering retains a rendering context.

### Installed-source implementation findings

Use the original materials with normal/depth MRT, emitting
`vec4(normalView, diffuseColor.a)` so alpha-to-coverage is retained. Use the
attachment's `NoBlending` rather than changing source materials. A scoped
render-object filter must inspect each actual group material: transparent
water currently writes depth, so filtering only `depthWrite === false` would
incorrectly admit it. Retain explicitly admitted alpha-tested/dithered cutouts;
exclude blended/transmissive effects, sky and non-depth writers. Diagnose
custom fragment/MRT overrides instead of silently treating their beauty output
as normals. The initial experiment requires native WebGPU compatibility mode
off, ordinary perspective depth and reflections off.

Keep the new owner separate from the legacy composer. Own the two scene
passes, AO, optional denoise/RTT, output pipeline and their private textures;
do not dispose the scene, renderer, shared maps or shared fullscreen geometry.
Construction needs rollback before publication, resize uses actual drawing-
buffer dimensions, and normal destruction/reinitialization must be tested.

Important failure boundary: installed PassNode, RenderPipeline, GTAO and RTT
draw paths do not comprehensively restore state with `finally`. An outer guard
can restore public renderer/context/camera state, but a native draw exception
can strand private render-scene state as well. Preserve the error and stop the
failed session; do not advertise a safe same-frame direct-render fallback or
reuse that has not been demonstrated. Native failure tests should exercise a
real throwing draw callback, check owned cleanup, then close that session.

## First comparison, not production defaults

Compare direct rendering, the identical pipeline with neutral AO, raw GTAO and
spatially denoised GTAO. Initial experimental parameters: radius 0.25 world
meters, scale 1, thickness 1, nominal samples 16, temporal off. Compare AO scales
0.5 and 1 without reducing the beauty pass. These are trial parameters, not
evidence that either looks correct or meets a frame budget.

Installed GTAO source turns nominal 16 samples into three directions and six
steps, with two horizon depth reads per step: 36 such reads per AO pixel,
besides other sampling. At 1280×720, the R8 AO target alone is 230,400 bytes
at half resolution or 921,600 bytes at full resolution. This excludes the
normal/depth prepass, beauty attachments, MSAA, resolves, denoising and noise
resources; it must not be presented as total GPU memory overhead.

The optional denoiser adds cost and should remain independently selectable.
[Official denoiser documentation](https://threejs.org/docs/pages/DenoiseNode.html).
Installed `DenoiseNode` emits inline 16-neighbor shader work, not automatically
another render pass. Materialize its result once in an owned depthless target
before beauty sampling; avoid repeating it for every receiving material fragment.

## Acceptance tasks

- [ ] Implement an opt-in owner with explicit resize, failure, teardown/reinit
      and renderer/context restoration. Release every owned pass, noise texture,
      material and optional denoise target, never the shared renderer or scene.
- [ ] Prove the neutral control retains output color/tone and alpha; inspect
      actual normal/depth for animated skin, moving grass and cutout trees.
- [ ] Capture matched lodge/interior, avatar/gear, trees/grass, shore and water
      views in actual headful Apple Metal WebGPU, then inspect motion and cuts.
      Reject halos, unstable foliage noise, black interiors and altered skin color.
- [ ] Measure actual pass/allocation changes, shader-build stalls and GPU time
      where supported, then sustained frame/thermal behavior on target hardware.
      RAF counts and CPU graph tests are not GPU-time or smoothness acceptance.
- [ ] Promote only after visible benefit and affordable cost are demonstrated;
      retain a tested direct-rendering path and explicit quality configuration.

Research checked 2026-09-12 UTC against official documentation and the installed
r186 source. No postprocessing or live graphics setting changed in this study.
