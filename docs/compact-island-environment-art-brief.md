# Compact island environment art: next delivery slice

User review, 2026-09-10: the current terrain is still lackluster and low quality.
This is accurate. Removing biome wedges and correcting sampled grass contact
did not turn the bare grass/dirt blockout into a finished game environment.

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
- [ ] Establish distinct ground materials with actual normal/roughness data,
  consistent texel density and believable stone/soil/turf/wet transitions.
  Inspect the existing local PBR assets before creating or acquiring replacements.
- [ ] Compose bounded rock, shrub and grass clusters around banks/paths, with
  intentional open circulation. Preserve batching, shared materials and LODs;
  do not blindly turn on bulk procedural population or grass everywhere.
- [ ] Resolve ocean material ownership and visible square water transitions.
  Ocean appearance must not change simply because a chunk center crosses a mask.
- [ ] Choose enough actual terrain geometry for the intended bank/detail shapes.
  Current final streaming leaves have 6.67 m grid spacing: grass projection fixes
  contact but cannot create missing terrain detail. Compare an explicit denser or
  local-detail candidate to the current baseline with recorded cost; do not hide
  resolution changes or claim arbitrary tessellation is free.
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

Read-only local inventory identifies `models/rocks/med_rock_v2.glb` and
`big_rock_v2.glb` (778/910 triangles, one primitive each, embedded albedo/normal/ORM)
as a small starting boulder pair. Existing round/path stones, ferns, shrubs and
oak variants can supply selected clusters after visual/texture-budget review.
The local `terrain/textures/{stylized_grass,dirt_ground,rock}` folders contain
normal/roughness maps that the active terrain shader does not currently use.

Do not enable the current generic vegetation path unchanged: it extracts only
the first mesh of an asset and its water-clearance policy excludes pond-bank
placements. Some low-triangle assets have large 2K textures; triangle counts alone
do not qualify them. A small authored workshop/shelter and reed/bank kit are still
missing. Imported asset creator/license attribution remains unresolved; this
inventory is reuse research, not a distribution-rights or performance approval.
