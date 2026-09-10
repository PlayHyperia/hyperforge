# Compact island environment art: next delivery slice

User review, 2026-09-10: the current terrain is still lackluster and low quality.
This is accurate. Removing biome wedges and correcting sampled grass contact
did not turn the bare grass/dirt blockout into a finished game environment.

Current work and explicit source-test/cost limits are recorded in
`compact-pond-bank-checkpoint-20260910.md`. The material/path/local-detail
candidate is implemented; it is not yet an accepted finished environment.

## Visual target, not a game screenshot

The imagegen skill was used to establish a concrete environment-art reference
with the built-in image tool. The local project copy is
`../asset-studio/island-environment-art-v1/compact-preparation-target01.png`
relative to the game repository; the full prompt is in `TARGET01_PROMPT.md`
beside it. PNG SHA-256:
`53817adc8d258ccb6b21582a0a228b8a18ed57e1b184f55e997dee1599e70b50`.
These authoring files are local, not part of the game source push.

The reference demonstrates deliberate rock/bank silhouettes, a readable natural
pond, differentiated stone/earth/grass/wet margins, grouped vegetation and a
connected workshop-to-arena route. It is **concept art**, not implemented assets,
approved placement, measured performance, or a promise of identical rendering.
Its arena count, building placements, dense foliage and decorative items are
not authoritative game data. Preserve functional IDs and validate any relocation.

## Build one finished preparation scene first

The first real art slice is the existing pond → bank/workshop → arena approach,
not another generic noise or palette adjustment across the entire map.

- [ ] Author clear primary/secondary landforms: low rocky ridge and coherent
      coastal silhouette; believable local pond banks and shallow depth; usable
      paths, flat interaction areas and unobstructed combat-camera sightlines.
- [ ] Give the bank, furnace/anvil and cooking locations a shared architectural
      setting and worn ground. Use a small reusable stone/timber kit; avoid isolated
      stations sprinkled on a lawn. Keep authoritative interaction positions valid.
- [x] Integrate six packed soil/turf/rock maps with actual normal/roughness/AO,
      exact-byte preflight and decode controls. Follow-up adds anti-repeat grass/dirt
      projections and worn path edges; finished wet-bank transitions remain open.
- [ ] Compose bounded rock, shrub and grass clusters around banks/paths, with
      intentional open circulation. Preserve batching, shared materials and LODs;
      do not blindly turn on bulk procedural population or grass everywhere.
- [ ] Use the existing choppable resource trees as the island's tree population,
      naturally distributed around the compact one-arena layout. Preserve reachable
      resource targets, tier availability, collision, depletion/regrowth and agent
      preparation. Do not fill the landscape with a separate decorative forest.
- [x] Resolve ocean material ownership and visible square water transitions.
      Ocean appearance must not change simply because a chunk center crosses a mask.
- [x] Compare bounded denser pond geometry: two100m streaming leaves now use128
      vertices/axis; hub policy64, other streaming leaves16. Final irregular-pond
      RMS error0.02764650m, maximum0.17675727m over7,921sample points. The two actual
      leaves have66,548triangles/2,690,928geometry bytes, +49,664triangles/+2,000,896
      bytes versus64. These are explicit costs, not frame-time acceptance.
- [ ] Finish pond/coastal topology and all-footprint prop contact; the measured
      residual bank error and circular silhouette are not a finished terrain gate.
- [ ] Capture actual close, preparation-wide and arena-approach gameplay views in
      consistent daylight, then moving-camera and night views. Evaluate composition,
      scale, material response, contact, silhouette and UI/agent readability together.
- [ ] Measure representative loading, CPU/GPU frame distributions and memory with
      the real agents/assets/stream workload before accepting performance. An image
      reference or intrusive static diagnostic cannot satisfy this gate.

Acceptance is an actual recognizably finished scene, visibly beyond the current
blockout while retaining the working preparation/duel loop. Numerical correctness
and material startup tests remain safeguards, not the main art deliverable.
The full island, equipment, reliability and launch checklist remain open.

## Existing-kit starting point

Read-only local inventory identifies `rocks/med_rock_v2.glb` and
`rocks/big_rock_v2.glb` (778/910 triangles, one primitive each, embedded albedo/normal/ORM)
as a small starting boulder pair. Existing round/path stones, ferns, shrubs and
oak variants can supply selected clusters after visual/texture-budget review.
The local `terrain/textures/{stylized_grass,dirt_ground,rock}` folders contain
normal/roughness maps now used through the six losslessly packed terrain maps.

Do not enable the current generic vegetation path unchanged: it extracts only
the first mesh of an asset and its water-clearance policy excludes pond-bank
placements. Some low-triangle assets have large 2K textures; triangle counts alone
do not qualify them. An isolated Blender pond kit now contains boulder, flat
stone, fern, bush and original reeds. The promoted CC0 Fern02 brings the kit to
approximately21.9427MiB estimated texture/mip allocation and37,068submitted
main-pass triangles across32instances/five batches. Probe17 verifies improved
wet margins/root contact, not finished habitat or representative performance.
A reviewed workshop-canopy candidate still awaits collision, flue and camera
integration. Imported asset creator/license attribution remains unresolved; this
inventory is reuse research, not a distribution-rights or performance approval.
