# Functional grove prerequisites — 2026-09-11

## Scope and status

In progress. This is an authority, grounding and visual-lifetime prerequisite,
**not completed grove composition or production acceptance**. The user wants
the existing harvestable trees to populate the compact island, with one arena
and no retained large island or duplicate decorative forest.

The last pushed renderer checkpoint is
`9c004c2ad82dc5291c385cfada73c1e614e09145`, paired with unchanged assets
`d6f52841f5d9173247e4499902ba1c27f96c2a89`. The changes below are a subsequent
working-tree candidate until a verified checkpoint is recorded.

## Why the landscape is still sparse

The actual compact manifest/generator census is eight procedural trees: three
palms, four bananas and one general tree. Five authored training trees are
separate. Resident renderer batch/LOD counts are not a geographic tree census.
The existing working woodland is insufficiently composed; this prerequisite
does not relocate or add trees, change species/yields, or claim to fix the art.

## Placement corrections

- Retain the existing seeded source-cell lattice and effective legacy coordinate
  IDs. Repartition it into the centred terrain chunks that own loading/unloading;
  do not shift every tree by half a chunk or adopt generator IDs as new authority.
- Each centred owner intersects four old source cells. Only candidates whose
  final snapped anchor belongs to that owner are emitted, in owner-local space.
- Ground the final snapped X/Z using deterministic authored terrain rather than
  whichever render height cache is resident. Recheck water, roads, slope and
  arena exclusion at that anchor.
- Both synchronous and actual worker-backed terrain assembly publish typed
  ownership, including an empty full-content generation that must replace old
  contents. Geometry-only warmup emits no resource replacement.

The tested compact census preserves all eight IDs, species, scales and rotations,
with no rejected candidates. Maximum root Y correction is 0.4668418331 m.
This is a CPU terrain result, not rendered root-contact acceptance. Source-cell
work is bounded to four existing generator calls per owner; no runtime entity
population increase is included. Higher-density groves still need measured cost.

## Registration and authority corrections

- Deduplicate identical registrations without resetting availability or respawn
  state. Conflicting variants/transforms or owners must fail before mutation.
- Serialize generations per tile and invalidate them on replacement, unload or
  destruction. Recheck after persistence and actual entity initialization awaits.
- Late cleanup may remove only the exact instance owned by that generation,
  never another entity which later acquired the same ID.
- Keep authored resources permanent across ordinary tile unload.
- When actual authoritative entity packets reuse a client-created resource,
  reconcile their depletion/transform and transfer ownership. Local terrain
  unload must not delete that server-backed entity. Cover both packet orders and
  single/batch delivery.
- Keep existing resource payload defaults unchanged, including `properties:{}`;
  this work does not invent health fields to satisfy a broader input type.

The existing early spawn-point metadata can still present speculative availability
on a client before durable hydration completes. Authoritative server gathering
remains fail-closed and later entity packets reconcile state, but eliminating
that transient presentation is an **open launch blocker**, not solved here.

## Tree visual lifetime corrections

Client entity creation can return before a shared tree model finishes loading.
Cancellation must reach the actual pool insertion boundary, not merely remove an
ID afterward: a newer tree may already use that ID. Current depletion must also
be sampled at insertion, so a pending load does not restore stale availability.

Tree collision proxies use shared cached geometry but private invisible materials.
Individual teardown must preserve the shared geometry while releasing private
resources. A destroyed entity cannot register interaction listeners, UI or hot
updates after an awaited visual load. Exact generation/world/scene checks after
each LOD await prevent retired worlds publishing pools into successor worlds;
an old pending promise cannot erase a newer promise's ownership. Individual tree
cancellation does not dispose another actor's shared model/pool.

The frozen implementation passed independent review and actual local HTTP-held
GLB loading tests through ClientLoader, ModelCache and GLTFLoader. This is CPU
lifecycle evidence, not GPU or visual acceptance. Malformed-GLB synchronous
construction rollback and other non-tree strategies' late-load paths remain
separate qualifications.

## Verification ledger

- [x] Root placement/generator/compact/worker/resource-transform runs: 59 cases
  across five files at the observed source state. Actual World, TerrainSystem,
  road/water systems and a real Node worker are exercised; no GPU qualification.
- [x] Root shadow/equipment regression: 139 cases across eight files pass after
  correcting an old test mock to preserve real viewport-module exports. This
  retains existing transport/model fixtures; they are not delivered-asset proof.
- [x] Root resource ownership and adjacent regression: 97 cases across nine files.
- [x] Integrated shared/client/server typechecks and fresh client/server builds.
  The server build was repeated after the shared/client build to bind the fresh
  shared runtime; competitive manifest prefix `ee21befc48be`.
- [x] Real PostgreSQL delayed-hydration cancellation and durable deadline reload:
  two new cases plus two existing durable-state cases pass. Actual table locks,
  blocked queries and committed gathering rewards are exercised; this does not
  prove socket delivery. Unique test databases and owned port-57832 container
  were cleaned; unrelated services were preserved.
- [x] Tree-pool lifetime/proxy ownership: 16 new real-loading cases pass in the
  root rerun; 35 cases across five suites pass in the implementation verification.
  Independent read-only review approved the frozen six-file change for GPU tests.
- [x] Capture focused actual Chrome/Metal daylight probe34: six camera views,
  twelve daylight PNGs plus six inherited baseline PNGs. All354 source pins,
  285 archived sources and18 PNG hashes/dimensions verified. No light/time/actor
  relocation. The UI-suppressed diagnostic retains inventory canvases; despite
  its `SCENE-ONLY-DIAGNOSTIC` filename it is not completely overlay-free.
- [ ] Approve daylight character contact/materials: probe34 does **not** pass
  this visual bar. Foot shadows look detached, armor remains visually flat and
  skin pale; geometry contact versus shadow projection/bias needs measurement.
  Actual actor roots differ by0.09m on the same flat lobby platform; root offsets
  are not sole-vertex measurements and must not be treated as proven boot gaps.
- [ ] Complete spatial regression, rendered hillside root contact and no ghost
  resources after actual streaming/unload/reconnect/depletion/respawn.
- [ ] Scoped commits/pushes with verified identity and exact evidence revisions.

### Probe34 evidence and limits

Detailed opt-in `shadows-720p60-v1`, 2026-09-11 05:32:20.934–05:34:24.754 UTC.
Focused study PASS; whole run FAIL remains19 cow/dagger content errors and cow
HTTP404. All37 recorded HTTP actions return200. Zero recorded GPU/page errors;
native pass tracing has86,493 matched begins/ends and24,054 finishes, no recorded
violations and restored wrappers. Texture tracing observes362 textures, zero
untracked textures or known destroyed references, but drops75,161 older events
and has9,596 unknown descriptors. This is bounded lifetime evidence, not proof
of every GPU use, performance, production assets or decoded broadcast output.
Owned browser/launcher close cleanly; ports3333/5555/9236/57831 are free.

Report SHA256: `44c4f6d25782a95366aa7966d6ff2be96e9da6274543c635c978ea777e2c413b`.
Shadow study SHA256: `94e751c38a4da2ebad67438114b3da63e12b869f08850b761a8fa4657ac46fa6`.
Built client SHA256: `989b0bf07edb5aed3b984d190390a162c54effe0c86e6d625b9be45fc4de765d`.

### Probe35 full spatial regression

Lightweight same shadow candidate, 05:34:55.711–05:37:24.160 UTC. The unchanged
full spatial14 study executes through additive-pin delegate15: eleven views,
28 total PNGs,37 HTTP200 actions. Root verifies all357 current source pins,
288 archives and PNG hashes/dimensions. Study PASS; whole FAIL retains19
cow/dagger content errors/cow404. Zero recorded GPU/page errors; clean owned
browser/launcher/ports. Lightweight mode intentionally has no native per-call
lifetime tracing and remains performance-ineligible.

Root image review sees resource-tree ground shadows and the retained single
arena, but still a uniform sparse lawn, overlapping training crowns, schematic
paths, oversized/isolated building presentation and an engineered circular pond.
This is not approval of hillside root contact or actual resource reload cycles.
The first10s post-equip scheduling window includes a1091.6ms RAF interval;
post-study max25ms. These are moving-camera callback observations, not presented
FPS or a controlled GPU-cost comparison, and do not establish smoothness.

Report SHA256: `7c2f9d484127980546f61f047339f76ef00c8782bc8c039f9aa39cef2299acae`.
Spatial study SHA256: `4ad6731205e82aac29cd2217c779802001cd755a24ef6b08634e290ce807ddf6`.

## Following art and launch work

Compose functional western/eastern groves and sparse southern continuation while
keeping preparation, banking, workshop, pond and arena routes open. Any relocated
or added resource identities, species mix and population budget must be explicit;
the current census-preserving prerequisite is not authorization-by-test to change
them silently. Inspect real crown bounds, pathfinder interaction approaches,
ground contact and complete harvest/regrowth behavior.

Separately qualify finer character/gear shadows, projection stability and useful
coverage, coherent terrain regions/shorelines, building scale and edge dressing,
wind/LOD shimmer and water. Performance acceptance requires a representative
production build, matched camera/light/population, GPU/CPU frame-time tails,
loading/memory and decoded stream evidence—not development RAF callback rates.
