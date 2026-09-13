# Lossless shield draw checkpoint — 2026-09-12

The candidate reduces rendered shield submissions without removing detail.
It does **not** complete asset art, fitting, smooth performance or launch gates.
No production item binding, avatar, terrain, shader, lighting, resolution or
shadow-quality setting changed in this checkpoint.

## Exact asset and native evidence

- Original `shield15-ior.glb`: SHA `24a9c90f8df7a62061b18c267cea210a6be155f1a62b95a6af7b25296c8c9dd8`.
- Opt-in `shield15-material-batched01-UNQUALIFIED.glb`: SHA `65e41104e6f3e7db84ba464a9d5303404a3da449f2af109ce46a52c017771fdf`.
- Both contain 4,664 vertices / 5,140 triangles, five opaque authored materials,
  22 original named anchors, exact fit metadata and two embedded PNG payloads.
  Candidate concatenates compatible material primitives: 23 to 5, 17,684 bytes
  smaller. Original and active production bindings remain unchanged.
- Independent transformed triangle/attribute proof, 15 corruption controls and
  Khronos zero-error/warning container validation pass. Native r186 GLTFLoader
  additionally confirms actual decoded texture pixels, colors, alpha, IOR,
  materials, geometry, anchor metadata and production-helper fits.
- Four private fits (original/candidate on both actual avatar hand poses) keep
  actor materials independent. Cleanup releases 20 private materials, 10 template
  materials, 28 geometries, four textures and four decoded images exactly once;
  the actual global image cache remains untouched.
- Real replicated equip/unequip on two actors and 32 post-tick animated idle
  samples each pass. All hand matrices change; wrapper/model identities and local
  fit stay fixed; both world-matrix chains are checked independently.
  Fifteen corruption controls against those actual receipts reject missing or
  duplicated actors/frames, identity swaps, fit shifts and forged error fields.
- Native draw census in both campus and meadow views: **46 to 10 shield draws
  per main pass and per sun-shadow pass; 10,280 triangles unchanged in each**.
  This is 72 fewer submissions across the two passes, not measured FPS gain.

Final run: `asset-studio/game-test-integration/shield-batching-native03/report.json`,
SHA `6db7e22427f74839955a3def7b5a31860f26a486b26bfa3cae086d9ebe31419f`.
695 source pins / 617 archives remain unchanged. All 36 required screenshot fog
brackets pass. Actual WebGPU, 1280×720, DPR1, MSAA4, sun map4096, eight unchanged
world views. Page/GPU/cleanup errors zero; owned browser, launcher and ports closed.
23 focused preflight tests pass. Overall run remains false with the same 19
missing-cow/dagger-fit errors: those are retained launch blockers.
Independent native-verification receipt SHA:
`ff811626b42fcadf0ea01949454272b17e9231c077afa9de796173571945621a`.

Native01 is retained as failed (28 added-image receipts versus old16 admission).
Native02 is retained as failed (old32 capacity omitted four of36 brackets).
Exact additional-view admission and a37-slot bound (36 plus one saved failure)
are now regression-tested; no projection, fog, quality or lifecycle guard was
relaxed. A supplemental read-only browser inspection overlapped native01's campus
timing, which is excluded from timing acceptance. Native03 had no such probe.

Short native03 p95 CPU ticks: 14.5 / 16.9ms; GPU-pass sums: 17.50 / 21.30ms
(campus/meadow). These remain unapproved headroom, not presented FPS, causal
speedup, sustained60 or full streaming/population tests. Moving NPC/pass census
differs across runs. Main and shadow shield-only savings are independently known.

## Visual verdict and next work

Clear outer-face views expose the existing **sideways kite-shield idle carry**.
The optimization faithfully preserves that fit; it does not make it correct.
Orientation/grip, walking/running/blocking/combat, transitions, partial-frustum
pixels and long-duration/reload gates stay open. Do not promote the candidate to
production defaults from matrix equality or a pleasing still.

Haven's next composed landform is prototyped externally: a bounded west shoulder
with unequal crest, rock faces, meadow shelf and drainage notch. 101,096 protected
probes and 48 archived resource-tree positions remain unchanged; existing two
refined terrain leaves suffice. This is not yet a game/worker/PhysX/navigation
or art approval. Steeper faces and internal slope transitions need native review.

The draw-reduction direction is consistent with [Three's same-material batching
guidance](https://threejs.org/docs/pages/BatchedMesh.html); this specific candidate
uses offline rigid primitive concatenation, not a new runtime batching system.
