# Fern source versus game-cache diagnostic

## Result

The prominent dark leaf patches are present in the untouched GLTFLoader source
as well as the game's cold ModelCache result. ModelCache is therefore not their
sole origin. It does introduce a smaller measurable darkening in this test;
source/candidate rendering parity has **not** been approved. The precise cause of
the main patches remains unresolved. Do not compensate by globally increasing
exposure or changing every plant's base colour.

The successful native02 comparison ran on actual headful Chrome/Apple Metal-3
WebGPU from 21:44:34.111 to 21:44:49.908 UTC on 2026-09-11. Two fresh pages load
the same real `pond_fern.glb`, then render near, oblique and rear views under
identical neutral directional/hemisphere lighting. No game IBL, shadows, palette
or replacement maps are used. Original materials pass through the renderer's
actual automatic Standard-to-StandardNode conversion; cached nodes pass through
by identity. The observer preserves the real return value.

## Controlled comparison

- All 2,248 actual triangles / 6,744 corner occurrences agree: world positions,
  UVs and bounds are exact; normals differ at most 3.653e-8, tangents 3.367e-8.
  Material sidedness and optical/alpha values agree.
- All three decoded map-byte hashes, dimensions, samplers and UV state agree.
  The base map changes from ImageBitmap to clamped DataTexture; unpack alignment
  changes from four to one. Normal and packed ARM textures stay ImageBitmap.
- Maximum absolute linear-channel differences are 0.059021 near, 0.051147
  oblique and 0.042053 rear. All three exceed the prior parity tolerance. The
  completed diagnostic is successful; equal pixels are not its pass condition.
- Root and the reviewing agent independently inspect all six PNGs and verify
  all 1,224 current source pins plus 1,224 archives (30,204,120 bytes), six PNGs
  (181,367 bytes) and six RGBA16F readbacks (14,745,600 bytes).
- Zero GPU/page/console/observer/cleanup errors. Both pages, renderers, owned
  browser and HTTP server close. Device destruction occurs only during teardown.
  These captures do not measure representative frame rate or certify asset art.

The separate first native01 remains failed and preserved: it produced all three
original-source pictures but rejected valid Uint8ClampedArray data in the
diagnostic helper before rendering the cached case. Successor02 admits the two
unsigned RGBA8 byte classes only, records the class, and retains every other
dimension, geometry, image, native-device and error gate. Root independently
passes its 12 tests, including signed/wider/float/incorrect-length negatives.

Evidence directory: `asset-studio/model-cache-fern-diagnostic01/native02`.
Report SHA-256:
`845996ebd48621b49d5b565395d75d0e7f2bda20177375e61241524a840aaecd`.
Bundle SHA-256:
`facce9070af0aab2478e08770381eb1c8cc484155adf512ffd83aa9c1e5d0965`.
The images are engine diagnostic renders, not full-game or decoded-stream views.

## Next investigation, not an implemented fix

Isolate the base-map upload path independently, then test authored two-sided
normal mapping, cutout boundaries and actual light response one variable at a
time. Source-normal/winding comparison found no inverted corners in this asset;
that does not validate tangent-space shading or every pixel. Packed AO values are
not black (red channel 200..255), so a black occlusion texture is not supported by
the evidence either. Keep all rejected hypotheses and source identity intact.

For a later leaf-translucency experiment, Three r186 includes an experimental
[MeshSSSNodeMaterial](https://threejs.org/docs/pages/MeshSSSNodeMaterial.html).
The [version-pinned example](https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/webgpu_materials_sss.html)
demonstrates thickness-controlled scattering. Local r186 source adds a direct-
light scattering term; it is an approximation, not complete physical subsurface
transport or a guaranteed cure for these patches. Do not install it before the
source/upload/normal diagnosis, and do not copy the demo's lighting or strengths
into the game. Any adoption needs alpha/shadow/instancing, dark/light/backlit
views, clone/ownership, performance and actual motion qualification.
