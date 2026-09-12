# Headland geometry study — 2026-09-12

**G04 remains open. None of these cliff drafts was installed or approved.**

The verified small-rock renderer and library are pushed as game `7209f4838`
and assets `6726595`, with GitHub author/committer both dreaminglucid. This
subsequent study investigated larger geology; it did not modify runtime code,
terrain profiles, placement, resource access, lighting or quality settings.

## Actual authoring and rejection evidence

Workspace evidence: `asset-studio/closed-headland01/README.md`, candidate
directories, exact executed scripts, preserved failures and source receipts.

- A 14m scanned-face derivative with bridged ends/rear produced 81,556
  triangles, no open edges and Euler2. Direct front/rear/side inspection rejected
  the artificial end walls, roof-like crown and stretched strips (candidate03).
- A revised closed-skin construction produced 75,292 triangles, no open edges
  and Euler2. Direct inspection rejected folded fins around the crown/ends
  (candidate05). Indexed topology alone was insufficient evidence of a good
  solid or a high-quality visual result.
- The bounded 8cm voxel cleanup stopped rather than discarding a disconnected
  412-vertex piece with 1.325206m² surface area and 1.825134m diagonal. Its
  fragment-removal allowances were not widened to pass the check (candidate07).
- Both rendered studies used Cycles CPU, 32 samples, denoising, 1440×900 and
  neutral authoring lights. These are not WebGPU or performance tests. No
  texture bake, game GLB, LOD set, collider or navigation changes resulted.

Original source models/maps and the live dirty avatar Blender file are
preserved. All owned Blender CLI processes exited. No new browser tabs were
opened. The previous native renderer evidence remains valid after this study;
its whole-session result still reports five missing-cow and fourteen dagger-fit
errors, separately from the passing scoped rendering study.

## Source screening prevented another unsuitable replacement

Official 2K glTF documents and geometry buffers for
[Rock Face01](https://polyhaven.com/a/rock_face_01) and
[Rock Face02](https://polyhaven.com/a/rock_face_02) matched publisher sizes/MD5s.
SHA256 receipts and exact downloaded bounds are retained in
`asset-studio/closed-headland01/source-screen01/report01.json`.

Exact-position geometry screening found 886/754 open edges respectively, with
boundaries spanning both assets' extents. They are not ready-made closed
replacements. The screening downloaded 1,184,091 bytes of model documents and
geometry plus metadata; no texture files, paid assets or new packages.

## Next work

Stop the rejected automatic dual-skin/voxel route. Build the landmark from a
sound closed mass or deliberately retopologized ends/crown, then qualify texel
scale, materials, LODs, ground transitions and placement. Existing closed
moss-rock geometry is a possible foundation for composition, but its small-prop
scale limits must not be bypassed without visual/material/error qualification.

Keep the broader target intact: replace synthetic ridge/coast shapes, improve
ground-to-rock/vegetation transitions and layered understory, and qualify
lighting, sky, water, contact/shadows and moving-camera/agent performance.
One compact island, one arena and functional harvestable trees remain required.
Neither passing geometry tests nor a good isolated render closes these gates.

Research checked the official [Three.js terrain example](https://threejs.org/examples/webgpu_tsl_procedural_terrain),
[SSGI example](https://threejs.org/examples/webgpu_postprocessing_ssgi.html) and
[Epic height-aware landscape blending documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-materials-in-unreal-engine).
They demonstrate available techniques, not measured performance in this game.
No additional SSGI pass or height-blending implementation is claimed here.
