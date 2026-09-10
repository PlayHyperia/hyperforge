# Lighting, sky and water for a coherent compact island

## Recommendation

The highest-value next rendering change is a coherent illumination model, not a larger texture pack or a stack of cinematic effects. The compact island should have one readable sun direction, believable indirect sky light, stable contact shadows, restrained material response and calm freshwater that visibly belongs to the surrounding terrain. These improvements are compatible with the existing WebGPU renderer, instancing, terrain detail regions and shared material ownership.

The recommended order is: establish a neutral color baseline; restore controlled image-based lighting for physical materials; reconcile custom foliage/water lighting with that baseline; fit shadows to the actual one-arena campus; then finish water depth, reflection and shoreline response. Evaluate a more sophisticated atmosphere only after the same scene looks convincing under a simple, stable sky. This order is an engineering and art-direction judgment, not a promise that any single switch produces AAA-quality results.

This section concerns illumination, PBR, sky, shadows, fog and water. It does not approve the current island composition, avatar fitting, animation or audio. Runtime observations must distinguish production defaults from temporary lighting overrides used in diagnostic captures.

## Compatibility and evidence boundary

The inspected root-resolved Three package reports **0.183.2**. Online Three documentation is rolling and already contains r186 changes: the current GTAO documentation, for example, marks two older parameters deprecated since r186. Implementation recommendations below therefore use the installed source and r183-tagged examples where possible, not an assumption that current documentation exactly matches the application. Package declarations, overrides, patched files and client/shared resolution require the separate dependency reconciliation before an upgrade; a root package version alone does not prove every bundle's version.[^1]

During source inspection, game HEAD reported `45435e97c`; the digests below identify the inspected file contents. These are source findings, not a new hardware performance measurement or a claim that probe 17 has passed. The one-arena migration remains a separate coordinated change: one 20×24 m ring, ID 1, with no hidden extra playable arenas.

## Why the current world can look flat, oversaturated or washed out

| Finding in current source | Consequence and confidence | Bounded response |
| --- | --- | --- |
| `Environment.updateSky()` loads a possible HDR but subsequently assigns `scene.environment = null`; startup also clears it. | **Confirmed missing production scene IBL.** The visible sky dome does not automatically illuminate physical materials. Lack of environment reflections can make armor and wet surfaces read as painted diffuse shapes. | Give the environment texture an explicit world-owned lifecycle separate from the background and planar reflector. |
| Daytime hemisphere intensity totals 0.9 and flat ambient totals 0.5, alongside sun multiplier 1.8. | **Confirmed configuration; visual causality requires comparison.** A strong nondirectional fill can weaken shape contrast. These arbitrary engine intensities are not a demonstrated calibrated lux/exposure system. | Rebalance fill only after adding IBL, with fixed-camera reference objects; do not add IBL on top of unchanged fill and assume the sum is correct. |
| Terrain has real albedo/normal/roughness/AO, but its albedo still passes through `applyAnimeShade()` before PBR. | **Confirmed extra directional/color treatment.** A physical light and a pre-lighting hue/rim treatment can disagree rather than reinforce material form. | Compact-only comparison with literal albedo and actual light response; preserve the historical treatment only where it demonstrably improves the intended style. |
| Tree RGB output uses warm/cool ramps, a 1.15 saturation boost and up to 1.3 rim multiplier. Batched trees cast shadows but have `receiveShadow=false`. | **Confirmed custom response.** Better leaf textures alone cannot establish lighting parity or canopy self-occlusion. It is possible to see a tree's ground shadow without convincing shaded foliage. | Preserve leaf alpha, bark, AO, wind and instancing; reduce competing color treatments and qualify actual received-light/occlusion behavior. |
| `WorldIlluminationUniforms` is a local material opt-in with default blend 0; its own contract excludes shadow visibility, directional IBL and a Fresnel BRDF. | **Confirmed limited mechanism.** Diagnostic key/fill control is useful evidence, but not a completed production lighting system. | Use it as an intermediate bridge for custom shaders, not as evidence that IBL or shadows already work there. |
| Moon, hemisphere, ambient and legacy sun-shade colors are strongly cyan/blue; night exposure rises from 0.85 to 1.1. | **Plausible explanation for blue-looking neutral assets.** This is not proof of a corrupt avatar texture. | Compare identical material bytes under neutral daylight and production night. Correct the light/presentation recipe rather than repainting skin to cancel a blue light. |
| Single-shadow constants are 4096 px across an orthographic ±200 m box. Comments still describe smaller settings. | **Confirmed allocation/span.** Nominal light-space spacing is 400/4096 ≈ 9.77 cm, before projection and filtering effects. The one-arena campus offers a better use of the same resolution. | Fit and stabilize coverage, then consider lowering resolution. Do not assume a 4096 map already gives close-up hand/foot shadow quality. |
| Custom sky-color fog starts at 400 m and reaches 800 m; ordinary scene fog has a separate configuration path. | **Confirmed dual policy.** Much of a compact island may receive no custom aerial separation, while loaded standard-material objects can follow another policy. This is not proof that fog caused a particular pale image. | Use one authored distance/color policy across material families; keep the foreground clear. |

Exact source observations are linked in the local evidence index below.

## Color and material response

### Establish a reference before changing the grade

Three's lighting calculations use Linear-sRGB. Color textures require sRGB decoding; roughness, normals and AO are data and must not receive that conversion. Display output needs its corresponding encoding once. A mismatched conversion can alter appearance in ways that changing light intensity cannot repair.[^2]

The current packed terrain design already follows an important part of this contract: albedo RGB is sRGB, roughness is linear alpha; normal RGB and AO alpha are non-color data. Keep that packing, exact downloaded-byte validation, flip/premultiplication controls and shared 1K ownership. The six maps occupy approximately 32 MiB with a complete RGBA8 mip chain; this is a format estimate, not measured backend residency. Packing does not certify the source art's realism or licensing history.

Use a temporary look-development scene or tagged removable references: a neutral diffuse object, a roughness sweep, a metal object, the actual avatar skin, stone, bark, foliage and wet/dry dirt. Compare the same camera, exposure and light direction, first with color treatments disabled only in the candidate branch. Inspect raw material factors and actual loaded color spaces alongside the image. A successful result preserves believable material differences rather than forcing every surface toward one brightness.

glTF separates surface color, microstructure and occlusion. Roughness and metalness share defined channels; normal maps describe tangent-space directions, while AO modifies indirect-light accessibility. This separation makes a mixed-source asset library more manageable, but it cannot compensate for inconsistent scale or baked-in illumination.[^3]

### Keep a restrained style, not literal photographic copying

Recommendation: use natural material response with deliberately simplified shapes and a controlled palette. Treat green leaves, pale stone, worn earth and warm metal as material families with variation, not as independent saturation knobs. Preserve gameplay-specific resource identification through silhouette, branching/frond shape, modest hue differences and UI labels; avoid relying on neon colors alone.

Do not bake a directional shadow, cyan night compensation or bright rim into base color. Broad texture variation can remain, but its amplitude should be judged after lighting is stable. For foliage, preserve alpha silhouettes and double-sided normal behavior and test front/back lighting. A cheap transmission approximation can be useful later, but it needs a bounded energy contribution and should not turn every backlit leaf fluorescent.

### Tone mapping is a finishing choice

Keep the present ACES/exposure baseline for the first comparison so that IBL and light changes are attributable. Subsequently compare ACES, installed AgX and Neutral using the same radiometric inputs. Khronos PBR Neutral was designed for color-faithful product presentation under controlled lighting; it is a useful diagnostic, not a universal preferred game look.[^4]

Do not solve washed-out surfaces by switching tone mapping, multiplying contrast and increasing saturation simultaneously. Check the WebGPU `RenderPipeline` output boundary as well as the direct renderer path: installed code temporarily disables renderer tone mapping during its scene work and applies the output transform at the pipeline boundary. An extra manual sRGB conversion would invalidate the comparison. DOM HUD colors and encoded streaming video also need a separate display comparison; a clean canvas does not by itself establish the delivery chain's color fidelity.

## Sky illumination and the visible sky

### Restore controlled environment lighting

Three exposes `Scene.background` and `Scene.environment` separately. The latter supplies environment lighting to physical materials; an explicit per-material envMap can override it. Consequently, a visible procedural sky and an independently filtered sky-light texture can coexist. Clearing the environment map is not inherently required merely because a planar reflection is used.[^5]

For the first candidate, add one modest-resolution HDR/PMREM environment to standard/node PBR materials and reduce redundant ambient fill. Confirm actual specular response on armor, damp soil and pond rocks. It will **not** automatically fix a custom shader that replaces final RGB: trees and water require deliberate adaptation rather than a claim of global parity.

The installed WebGPU export is `PMREMGenerator` from `three/webgpu`, backed by `src/renderers/common/extras/PMREMGenerator.js`. Initialize the renderer before generating its result; the old async convenience methods are deprecated in this version. A 1024×512 equirectangular input produces a 256-face-size PMREM. This is real r183 WebGPU functionality, not a proposed backend fallback.[^6]

Budget calculation from the installed allocation: at cube size 256, the half-float RGBA CubeUV target is 768×1024×8 bytes ≈ 6 MiB. Filtering also uses a comparable ping-pong target; the source 1024×512 half-float image would add 4 MiB if retained in that format. Allow for temporary allocations and implementation-specific overhead. At cube size 512 the output target becomes 24 MiB. These calculations favor starting small and measuring visual roughness response before increasing HDR resolution.

The environment owner must retain the output render target until no material samples it, dispose generation scratch when safe, and reject stale async publication after world teardown. Avoid a PMREM per material, per vegetation chunk or per frame. Startup, replacement and disposal are part of the feature, not subsequent cleanup work.

### Use one coherent outdoor condition

Filament's reference model treats distant image-based light as incoming illumination from the surrounding environment and prefilters it for material response. It also emphasizes separating material parameters from light. The transferable lesson is consistency and energy accounting; adopting Filament's engine, physical-unit exposure conventions or rendering code is unnecessary.[^7]

For a bright, readable fantasy island, prefer a mildly warm key, restrained cool sky fill and a quiet horizon. A visible sun and a strong captured HDR sun need aligned direction and an explicit direct-light policy; otherwise the scene may contain contradictory or doubled highlights. Normalize imported HDR lighting against the reference scene, not a file's visual thumbnail or the number of exposure stops listed by its provider.

Preserve the existing day/night feature. First validate fixed day, dusk and night states; then qualify transitions. A daytime HDR that remains bright after sunset is not acceptable. Possible next designs are a few precomputed authored environment states or infrequent, budgeted sky-only PMREM updates. Neither strategy is free: blending two environments changes sampling cost; runtime generation adds capture/filter work and must avoid visible pops. Choose only after the fixed-state result is accepted.

### Sky rendering: reuse first, atmosphere later

Installed Three includes the WebGPU `SkyMesh` analytic sky and r183 examples showing sky and scene-derived PMREM. They provide a useful compact reference for separating sky parameters from scene illumination, not an automatic replacement for this project's day/night, fog, cloud and reflection ownership.[^8]

Hillaire's 2020 atmosphere work separates slowly varying sky/aerial-perspective quantities into lookup tables and retains important directional features. That is a strong future architecture for scalable atmospheric coherence. The accompanying implementation is Windows/DX11/HLSL and is not a drop-in TSL component. Planet-scale views, multiple-scattering machinery and full volumetric clouds are not prerequisites for a convincing small island.[^9]

Immediate recommendation: keep a simple sky and existing low-resolution fog-color mechanism, correct horizon palette and sun alignment, and unify fog application across physical and custom materials. If a later atmosphere implementation is justified, validate LUT precision, horizon seams, color-domain handling and update cost before replacing a stable baseline. Do not add ray-marched cloud volumes merely to hide empty composition.

## Shadows and contact

### Fit the useful area before increasing samples

One arena creates an opportunity to concentrate shadow quality around the fighters and preparation views. A 2048 map spanning 80 m has nominal 3.91 cm spacing; 4096 across the current 400 m spans 9.77 cm per texel. This arithmetic is not a complete visual-quality predictor, but it demonstrates why a larger texture can still produce weak contact shadows.

Recommendation: determine a conservative light-space caster/receiver region around each broadcast composition, include offscreen objects whose shadows enter it, and stabilize movement with quantized light-space updates. Fit neither just the screen rectangle nor just the two fighter centers. Check sunset, where long shadows expand the required caster region. Preserve moving skin, weapon, foliage-wind and shadow geometry correspondence.

Use one directional shadow pass as the baseline. Cascaded shadows partition view depth and may improve close/far coverage, but each cascade adds work and a transition to validate. Three provides a WebGPU `CSMShadowNode`; its existence does not establish that four cascades at 4096 are the correct production choice.[^10]

Retain actual receiver/caster inspection. Ground, avatar, armor, rocks and foliage may use different material paths. More AO cannot replace missing tree reception or correct floating geometry. Shadow bias is a depth-precision control, not a way to conceal a physically intersecting floor; the previous hospital investigation already demonstrated that material properties alone do not prove the bound GPU pipeline used them.

### Ambient occlusion is secondary

Use existing baked asset AO conservatively before adding a screen-space pass. A short-radius GTAO candidate may improve feet, rock bases and crevices after geometry and direct shadows are correct. Three's r183 implementation has an optional half-resolution output, depth/normal dependencies and temporal-filtering tradeoffs.[^11]

Do not copy the current r186 AO-composition example into 0.183.2 without compatibility checks. The installed GTAO source has version-specific depth reconstruction, while the application has custom output shaders, transparent water and potential reversed-depth configuration. Evaluate an actual WebGPU frame with the exact pipeline, not only whether the node compiles. Avoid blindly multiplying final lit color by AO, which can muddy direct light, emission and sky; determine the appropriate indirect-light integration on the chosen version.

Temporal filtering, if used, must be tested through camera cuts, teleportation, animated alpha foliage and weapon motion. Persistent dark trails or flickering vegetation outweigh a cleaner still image. An AO pass is optional until its measured benefit exceeds its bandwidth, integration and temporal cost.

## Water that belongs to the island

### Preserve useful systems; separate pond and sea behavior

The existing system already has GPU waves, flowing normals, a half-resolution planar reflector, elevated water-body identity and a distinct ocean material. These are useful foundations. A freshwater pond does not need the same wave steepness, foam or specular rhythm as the coast.

GPU Gems' water model separates geometry-scale waves from fine normal variation and relates wave parameters to wavelength and steepness. Its old hardware cost claims are not applicable to this game; the reusable principle is spending geometry only on visible surface motion and keeping fine ripples in shading.[^12]

Keep the irregular pond bank and actual water-body geometry as the shoreline authority. The current compact quiet-pond path already suppresses broad surf foam; do not undo that correction while researching a new shader. Add localized interaction ripples later only where fishing or impacts visibly justify them, with a bounded particle/decal/simulation budget.

### Correct the optical model before adding complexity

The legacy lake path is explicitly a custom composition: `RF0=0.3`, white Phong highlight, depth-color blending, reflection intensity 0.4 and a strong final water-color mix. Merely assigning roughness 0.8 to its `MeshStandardNodeMaterial` does not turn the replaced RGB into a physically based water BRDF.

At an ideal air/water boundary using refractive index ≈ 1.333, normal-incidence Fresnel reflectance is approximately `((1.333-1)/(1.333+1))² ≈ 0.0204`; reflectance increases toward grazing views. This calculation is a physically motivated baseline, not a claim that changing the existing constant alone corrects its nonphysical mixture.[^13]

Introduce a cohesive energy split: reflection follows the Fresnel term; transmitted bottom/scatter contribution occupies the remainder. Use linear radiance and a clearly defined path-length estimate. For a homogeneous participating medium, Beer transmittance decreases exponentially with extinction coefficient times travel distance; a bounded RGB approximation can give shallow edge visibility and richer deep water without a painted opacity ramp.[^14]

Do not confuse camera-space depth difference with horizontal shoreline distance. The current `linearDepth(scene)-linearDepth(water)` is useful for an approximate view-ray thickness after unit conversion, but varies with view and opaque depth availability. It should not decide where a permanent white shore band or wet soil exists. Near shoreline, offscreen geometry and silhouettes require clamping and explicitly tested fallback behavior.

A water material experiment must preserve authoritative fishing/water membership and terrain height. It should not move the pond surface or bank merely to satisfy a reflection screenshot. Test bottom visibility from overhead and grazing angles, edge continuity, pale-halo absence, depth-write interactions, actor/foliage overlap and night color. Submerged object disappearance may be transparency/depth ordering, not opacity art direction.

### Bound reflection cost and ownership

Three's `ReflectorNode` renders an additional view for a planar surface and exposes resolution, bounce and lifecycle controls. The local pond already uses scale 0.5. That reduces target pixel count to roughly one-quarter at the same aspect ratio, but does not guarantee quarter draw-call, vertex, shadow or CPU-submission cost.[^15]

Keep one active pond reflection plane, verify its world-space height and actual owner, and disable recursive reflector bounces where not needed. Frustum/distance culling and a measured lower update rate are candidates, but moving fighters, foliage and sun reflections must not stutter. The ocean should keep its cheaper environment/sky approximation unless a hero composition proves a second capture worthwhile. A static HDR cannot replace local reflections of a nearby actor; a planar capture cannot replace all diffuse IBL either.

## Online resources worth trying

Poly Haven states its downloadable HDRIs, textures and models are CC0, including commercial reuse and redistribution. Website example renders, logos and editorial content are separate; do not use a preview image as a game texture. Keep asset URL, author, license URL, download metadata, source hash and conversion recipe even when attribution is optional.[^16]

| Exact asset | Proposed role | Available formats and restrained starting point | Limitation |
| --- | --- | --- | --- |
| [Kloofendal 48d Partly Cloudy — Pure Sky](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky), Greg Zaal / sky edit Jarod Guest | First sunny-sky/IBL comparison; sky-only avoids importing a foreign terrain horizon | HDR/EXR, 1K through 16K listed; start with 1K IBL, not the default large download | Strong sun requires direction/exposure calibration; it is not automatically the approved island sky.[^17] |
| [Overcast Soil — Pure Sky](https://polyhaven.com/a/overcast_soil_puresky), Sergej Majboroda / sky edit Jarod Guest | Soft neutral-ish material inspection and alternative subdued weather | HDR/EXR, 1K–16K; start at 1K for lighting | Low contrast can itself feel flat; use as a controlled comparison, not a cure for weak composition.[^18] |
| [Kiara 1 Dawn](https://polyhaven.com/a/kiara_1_dawn), Greg Zaal | Secondary dawn material/metal reflection test | HDR/EXR, 1K–16K | Contains a rocky valley horizon; unsuitable as an unmodified visible coastal-island background.[^19] |

No replacement ground-texture download is required to test the lighting hypothesis. The existing six packed maps are sufficient controls. If their art remains too stylized after illumination is corrected, replace one material family at a time through the existing packer and hash contract; do not grow a second unbounded texture library. Prefer a consistent source scan's albedo, OpenGL-oriented normal, roughness and AO, then preserve that relationship across all packed resolutions.

## Cost-aware acceptance sequence

| Candidate | Expected cost shape, not a benchmark | Required acceptance evidence |
| --- | --- | --- |
| Correct color annotations and remove conflicting tint treatment | Mostly uniform/graph changes; potentially less arithmetic | Neutral controls and actual avatar/material colors remain stable across sun orientations; no new display conversion |
| One 256-face-size PMREM | Texture sampling plus ≈ 6 MiB retained output, generation scratch/startup work | Actual material reflection response, correct ownership, no stale publication, no per-frame regeneration |
| Tighter single shadow coverage | Same or lower map memory; caster counts vary | Feet/weapon/tree contact and offscreen-caster coverage, stable camera motion, no acne or detached shadows |
| Quiet-pond optical composition | Bounded arithmetic using existing samples; reflection remains major pass cost | Clear shallows/deeper color, angle-correct reflection, no halo or transparency clipping |
| Optional half-resolution GTAO | Additional target, depth/normal traffic and sampling | Improved contacts in motion, no halos/ghosting, measured budget on both target platforms |
| Atmosphere/cloud expansion | LUT generation or volumetric sampling and additional lifecycle complexity | Only after simpler sky/IBL/fog is accepted; no promised console-paper timing transplanted to browser |

For each accepted slice, retain exact served sources/assets and actual renderer/material settings, one unchanged camera path, a cold-load sequence and a warm steady-state sequence. Inspect the actual ordinary scene as well as diagnostic controls; do not promote a candidate because a modified lighting rig looks good while production defaults remain unchanged.

Performance review needs at least median and tail frame times, resolution/DPR, GPU identity, active passes, actual shadow/reflector dimensions and asset memory estimates. A 30 fps stream has 33.33 ms per delivered frame and 60 fps interaction 16.67 ms, but neither number is the available GPU budget: scene rendering, browser work, capture and encoding need headroom. CPU ray/contact instrumentation frames must be excluded from representative performance claims. Measure before/after on the required macOS Chrome/ANGLE Metal and Linux Chrome/ANGLE deployment paths; do not infer one from the other.

Day/night tests must include transitions, not only three isolated stills. Camera cuts, return-to-lobby teleportation and long-running resource turnover exercise shadow, reflection and temporal state differently. Preserve zero unexpected GPU/page errors and bounded cleanup. Treat correct pixels, stable gameplay and sustained performance as separate gates; none substitutes for the others.

## Implementation boundaries

1. **Shared color/lighting recipe:** `LightingConfig`, `Environment`, `ClientGraphics`; one owner for sun, fill, exposure and time-of-day recipe. No dependency upgrade bundled into the art change.
2. **Environment resource owner:** WebGPU PMREM initialized and disposed explicitly; separate sky/background/IBL/planar-reflection responsibilities.
3. **Material-family adaptation:** `TerrainShader`, `GPUMaterials`, `GrassVisualManager`, loaded model materials and `WaterSystem`; preserve geometry, alpha, wind, instance counts and gameplay identification while aligning illumination.
4. **Shadow fit:** `Environment`, actual camera focus and caster/receiver bounds; no high-cascade default until measured.
5. **Water candidate:** `WaterSystem` plus existing water ownership; optical changes only, no hidden physical-height/fishing contract change.
6. **Fog/sky coherence:** `SkySystem` and `FogConfig`; common color domain and distance semantics. Advanced atmosphere remains a separately budgeted enhancement.

Transfer the principles from production rendering research—consistent radiometry, separation of material/light, stable visibility and bounded approximation. Do not import Unreal/Frostbite feature lists as launch requirements, assume their native-engine timing applies to WebGPU, or introduce a backend fallback. The intended result is a coherent, appealing, reliable island at the available hardware budget.

## Local evidence index

Paths are absolute; line numbers identify the inspected source and may move after implementation.

- [ClientGraphics: renderer color/tone mapping](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/client/ClientGraphics.ts:189>).
- [Environment: environment map cleared](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/world/Environment.ts:395>); [ambient update](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/world/Environment.ts:756>); [exposure](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/world/Environment.ts:822>); [single shadow setup](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/world/Environment.ts:1056>). SHA256 `6b2aea05961063a7d8d6afe1697217e27b6f605fca0da8168f815b167df52f36`.
- [LightingConfig](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/world/LightingConfig.ts:1>). SHA256 `dc35fa25618871018ab0280fd6c14ced085373c1cad00fa20e59808676bfbbab`.
- [TerrainShader: pre-PBR shade](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/world/TerrainShader.ts:1626>) and [physical material graph](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/world/TerrainShader.ts:1779>). SHA256 `eb991339d8f048866e5d092d565b8da355b85b09ba238ea6c7ec3e6e07f83a2e`.
- [Tree custom output](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/world/GPUMaterials.ts:1188>); [tree shadow flags](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/world/GLBTreeBatchedInstancer.ts:289>).
- [WorldIlluminationUniforms](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/world/WorldIlluminationUniforms.ts:1>). SHA256 `1dc73047c222db5721e8e10aecfa61dea612100de13aa39be42f9210e189e301`.
- [WaterSystem configuration](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/world/WaterSystem.ts:66>) and [quiet-pond foam exclusion](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/world/WaterSystem.ts:960>). SHA256 `deab08c2d22ddddef5520fb312b6b1f14fd29b76445ee0f2cc392a1e938dd70d`.
- [FogConfig](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/world/FogConfig.ts:1>); [current packed texture provenance](</Users/lucid/Documents/hyperia/hyperia-implementation/packages/server/world/assets/terrain/textures/compact-pbr/packing-manifest.json:1>).
- [Installed WebGPU PMREM](</Users/lucid/Documents/hyperia/hyperia-implementation/node_modules/three/src/renderers/common/extras/PMREMGenerator.js:1>). SHA256 `e1b941b118f8399169fc1f800223e6671629370905dbb80f6ad065720bdc6d08`.
- [Installed shadow node](</Users/lucid/Documents/hyperia/hyperia-implementation/node_modules/three/src/nodes/lighting/ShadowNode.js:1>). SHA256 `447ae462732280cdf1ac17b1a9e22347afc980b618870ad6fb5e0e86c38ca31c`.

## Sources

All online sources were consulted on 2026-09-10. Undated documentation is identified as such; crawl dates and search-engine upload dates are not treated as publication dates. References support the immediately associated principles or API facts; numerical project budgets and implementation priorities are calculations/recommendations, not published benchmark results.

[^1]: Three.js contributors. [GTAONode documentation](https://threejs.org/docs/pages/GTAONode.html), rolling/undated, including explicitly labeled r186 deprecations; [r183 GTAONode source](https://raw.githubusercontent.com/mrdoob/three.js/r183/examples/jsm/tsl/display/GTAONode.js), release-tagged primary implementation. Local installed package and source inspection establish the 0.183.2 compatibility boundary.
[^2]: Three.js contributors. [Color Management](https://threejs.org/manual/en/color-management.html), rolling/undated. Linear working space, color/data texture annotation and output-conversion principles; older backend-specific sample snippets are not proposed for this project.
[^3]: Khronos 3D Formats Working Group. [glTF 2.0 Specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html), maintained 2.0 specification, §3.9 and material property definitions; [PBR material glossary](https://www.khronos.org/gltf/pbr), rolling/undated. Material channel and normal/roughness/occlusion semantics.
[^4]: Khronos Group. [Khronos PBR Neutral Tone Mapper specification](https://github.com/KhronosGroup/ToneMapping/blob/main/PBR_Neutral/README.md), maintained specification; [glTF: Now and Next](https://www.khronos.org/blog/gltf-now-and-next), 2024 context. Neutral is a controlled color-fidelity option, not a game art-direction mandate.
[^5]: Three.js contributors. [Scene](https://threejs.org/docs/pages/Scene.html), rolling/undated. Separate background, environment, intensity and rotation responsibilities, checked against installed `src/scenes/Scene.js`.
[^6]: Three.js contributors. [WebGPU PMREMGenerator, r183](https://raw.githubusercontent.com/mrdoob/three.js/r183/src/renderers/common/extras/PMREMGenerator.js), release-tagged primary source. Installed 0.183.2 implementation also inspected for initialization, target dimensions and formats. The similarly named general PMREM documentation describes another class; do not choose imports from that page blindly.
[^7]: Romain Guy and Mathias Agopian, Google. [Physically Based Rendering in Filament](https://google.github.io/filament/main/filament.html), maintained/undated technical reference; material/light separation and §5.3 image-based lighting. Principles only, not an engine migration or copied platform budget.
[^8]: Three.js contributors. [WebGPU sky example, r183](https://raw.githubusercontent.com/mrdoob/three.js/r183/examples/webgpu_sky.html) and [WebGPU PMREM scene example, r183](https://raw.githubusercontent.com/mrdoob/three.js/r183/examples/webgpu_pmrem_scene.html), release-tagged primary examples; installed `examples/jsm/objects/SkyMesh.js` also inspected.
[^9]: Sébastien Hillaire, Epic Games. [A Scalable and Production Ready Sky and Atmosphere Rendering Technique](https://onlinelibrary.wiley.com/doi/10.1111/cgf.14050), Computer Graphics Forum 39(4), 13–22, first published 20 July 2020. [Author's SIGGRAPH 2020 presentation](https://blog.selfshadow.com/publications/s2020-shading-course/hillaire/s2020_pbs_hillaire_slides.pdf), especially slides 10–11; [author's accompanying implementation](https://github.com/sebh/UnrealEngineSkyAtmosphere), 2020 project, maintained repository. Recommendations use the publisher abstract, author presentation and implementation rather than an inaccessible full-paper endpoint.
[^10]: Three.js contributors. [CSMShadowNode](https://threejs.org/docs/pages/CSMShadowNode.html), rolling/undated. Cascaded shadow mechanism; application resolution/span calculations are independent local analysis.
[^11]: Three.js contributors. [GTAONode, r183](https://raw.githubusercontent.com/mrdoob/three.js/r183/examples/jsm/tsl/display/GTAONode.js), release-tagged primary implementation, plus locally installed code. Resolution, depth/normal input and temporal tradeoffs; current r186 compositing examples are not assumed compatible.
[^12]: Mark Finch, Cyan Worlds. [Effective Water Simulation from Physical Models](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models), GPU Gems, NVIDIA/Addison-Wesley, 2004, §§1.1–1.2. Reusable wave/normal principles only; historical hardware performance claims are excluded.
[^13]: Matt Pharr, Wenzel Jakob and Greg Humphreys. [Specular Reflection and Transmission](https://pbr-book.org/4ed/Reflection_Models/Specular_Reflection_and_Transmission), Physically Based Rendering: From Theory to Implementation, 4th edition, 2023, §9.3. Fresnel/dielectric principles; 0.0204 is a calculation using the stated approximate refractive index.
[^14]: Matt Pharr, Wenzel Jakob and Greg Humphreys. [Transmittance](https://pbr-book.org/4ed/Volume_Scattering/Transmittance), 4th edition, 2023, §11.2. Homogeneous-medium Beer attenuation; a screen-depth approximation is not a full transport simulation.
[^15]: Three.js contributors. [ReflectorNode](https://threejs.org/docs/pages/ReflectorNode.html), rolling/undated, checked against installed 0.183.2 `src/nodes/utils/ReflectorNode.js`. Planar-reflector controls and disposal; quarter-pixel count is geometric calculation, not measured frame-cost savings.
[^16]: Poly Haven. [Asset License and Terms](https://polyhaven.com/license), undated/current. CC0 downloadable assets; separate treatment of website content and API terms. This is provider provenance, not a general legal opinion about every third-party asset.
[^17]: Greg Zaal and Jarod Guest, Poly Haven. [Kloofendal 48d Partly Cloudy — Pure Sky](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky), asset page, exact publication day unavailable in retrieved text. Provider lists CC0, HDR/EXR and 1K–16K variants.
[^18]: Sergej Majboroda and Jarod Guest, Poly Haven. [Overcast Soil — Pure Sky](https://polyhaven.com/a/overcast_soil_puresky), asset page, exact publication day unavailable. Provider lists CC0, HDR/EXR and 1K–16K variants.
[^19]: Greg Zaal, Poly Haven. [Kiara 1 Dawn](https://polyhaven.com/a/kiara_1_dawn), asset page, exact publication day unavailable. Provider lists CC0, HDR/EXR and 1K–16K variants.
