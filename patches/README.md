# Three WebGPU completed-context lifecycle fix

`three@0.183.2.patch` is installed by Bun through `patchedDependencies`.
It changes the source backend and the two unminified distributed WebGPU bundles;
the game imports `three/webgpu`, which resolves to `build/three.webgpu.js`.
Direct imports of upstream minified bundles are not covered by this patch.

The backend previously retained `currentPass` and `encoder` after `finishRender`.
A later `compileAsync` can reuse that pooled context. A transmissive material's
`ViewportTextureNode` then attempts a framebuffer copy using the ended pass and
finished encoder. Actual Chrome/Metal game traces captured both native lifecycle
violations and Dawn validation errors on this path.

The patch clears the pass after the final normal/depth-array branch, retains the
encoder for occlusion resolution, then releases it after submission. Framebuffer
copies outside rendering use the existing independent-encoder path. Copies during
an active render still end and resume that active pass. Transmission, mipmaps,
pipeline compilation, and application readiness are not disabled or bypassed.

Install with `bun install --frozen-lockfile`. Verify installation with
`node --test scripts/three-webgpu-patch.test.mjs`. These provenance tests are not
GPU behavior tests. Hardware regression must also cover completed render →
transmissive precompile → live rendering, native encoder lifecycle, GPU validation,
and the actual avatar/equipment inventory flow. Do not infer visual, performance,
or launch approval from installation tests.

On a Three upgrade, re-evaluate the upstream lifecycle code and rerun the hardware
regression before updating/removing the patch and its exact-byte checks. Do not
carry it forward blindly or edit only `node_modules`.
