# Compact landscape and grounded actors — measured candidate, 2026-09-11

## Acceptance boundary

This work follows pushed game `84a18a123` and assets `e26cc737`. It is not
AAA, launch, default-render-profile, performance or decoded-stream approval.
There is one arena, no retained large runtime world, and no decorative forest.
Historical terrain constants are regression fixtures, not selectable legacy worlds.

## Actual contact correction

One player support rule resolves actual building floors, interior stairs, entrance
steps, the solid duel-platform top, or bridge-aware terrain, then applies one
centimetre of player clearance. The navigation grade stays 2 cm below the physical
platform top. Avatar geometry, animation, boots and other resource transforms are
unchanged. Furniture can block navigation without removing its underlying floor.

Embedded spawning, arena/streaming placement, both server movement loops and
player-only client interpolation use the rule. Initial facing state and teleport
reconciliation now retain authoritative Y. Generic character-selection's existing
terrain+1 spawn policy and valid saved-position repair thresholds are unchanged.

Probe39 used an actual headful Chrome/Metal WebGPU world at the same explicit
720p/DPR1/shadow profile as probe37. Its study passes measurement completeness, not
contact approval. Whole-run status remains **FAIL** for the inherited cow asset
and dagger metadata errors. It records zero GPU/page errors and clean owned
browser, service and database cleanup.

| Actual lobby measurement | Probe37 | Probe39 |
| --- | --- | --- |
| Solid floor top | 28.8393015291 m | unchanged |
| First actor root | 28.9193015231 m | 28.8493015231 m |
| Second actor root | 28.8293015231 m | unchanged |
| Root difference | 90 mm | 20 mm |
| First boot left minimum range | +79.03 to +79.97 mm | +8.83 to +9.97 mm |
| First boot right minimum range | +75.60 to +76.62 mm | +5.45 to +6.58 mm |
| Second boot left minimum range | −10.97 to −10.03 mm | −11.17 to −10.04 mm |
| Second boot right minimum range | −14.40 to −13.38 mm | −14.55 to −13.42 mm |

The capture exposed a missed occupied-spawn relocation path: the second agent
was moved to (384.5,374.5) using terrain+.01, below the actual solid floor.
That path is now corrected and a real two-player occupancy/packet/persistence
regression passes. Probe41 below verifies the final correction;
probe39 is retained as the earlier partial result, not retroactively relabeled.

The 24 before/after measurements use actual CPU-deformed mesh vertices and actual
floor triangles. Twelve captures advance animation naturally with stable owners;
they are not exact screenshot-pose GPU readback or a foot-pressure/IK test. The
scene-only diagnostic still includes some rendered inventory UI.

Probe39 integrity: all 383 source pins, 313 archives and 18 PNGs independently
verified; six terrain and five pond-model HTTP bodies match prelaunch digests.
Report SHA256 `774247acad7e12407ebdbf03225423435e3eb419aadb2eb379a7ebbf47448986`;
study SHA256 `6a39550857c964af918d87ebddee79eec031faebcc469fb01e56cc34ee92fd2c`.
Evidence directory: `asset-studio/game-test-integration/compact-world-probe39`.

### Final occupied-spawn correction: probe41

The separate actual Chrome/Metal detailed contact study passes. Both agents now
have root/entity Y `28.84930152309769`, at original (385,374) and relocated
(384.5,374.5). The actual floor top is `28.83930152905815`. All 24 before/after
boundaries have zero root-height difference; the relocated agent rises 20mm from
probe39 while the first agent is unchanged. Both left boot sole minima range
+9.100 to +9.975mm and right minima +5.656 to +6.615mm. No measurement penetration
or separation flags are raised. Twelve owner brackets remain stable while all
twelve sampled poses advance naturally. Each boundary checks 10,090 actual
deformed vertices against 20,180 floor triangles.

This verifies support consistency, not perfect foot planting, IK, movement or
art approval: `contactApproved` remains false and the documented CPU-measurement
limits still apply. Root inspection of the quarter/contact PNGs confirms both
agents visibly stand at the same level. Skin, metal and coarse shadow appearance
still require work.

Independent integrity verification: 401 source pins, 331 archives and 18 PNGs.
Report SHA256 `11d3035c366cb485ec9cc43a3e6f06eba63a1aea3d4438b29f919ec6d1b5967d`;
study SHA256 `f05bff9eada12aa223e25914fba08e22558e7b94c1cfef44651d66fb61fe3c09`.
Evidence: `asset-studio/game-test-integration/compact-world-probe41`.

Whole-run status is still **FAIL** for the same 19 inherited cow/dagger errors,
with zero GPU/page errors or new error classes. Camera, owned browser, ports,
launcher and instrumentation cleanup passed. All six terrain and five pond-model
HTTP bodies matched prelaunch hashes. Detailed instrumentation observed zero
native encoder violations and zero sampled destroyed-texture-reference failures,
but retained 83,018 dropped ring events, 10,448 unknown descriptors and 53,597
untracked render-bundle sampling events. It is not complete resource-lifetime or
performance proof. The contact captures use natural day phase .44083–.45551.

## Landscape and surface candidate

- Explicit v3 compact profile: asymmetric western ridge/headland and an inward
  southeast inlet, with shared authoritative and worker geometry. The envelope
  and functional grades remain unchanged. Exact tree identity,
  placement, variant, scale and generator outcomes are regression requirements.
- Warmer dry-meadow albedo variation and rock exposure beginning near 22° actual
  geometric slope. Existing paths and narrow pond-soil overrides retain ownership.
  This is not an authored grove-soil mask. CPU grass-base arithmetic matches TSL;
  six textures, 14 surface samples and grass density remain unchanged.
- A shared weathered limestone surface replaces the mismatched tan lobby, white
  hospital and arena materials. Running-bond stones, material variation, roughness
  and 6mm lighting-only relief use no extra textures or geometry. Screen footprint
  fades fine detail; actual motion and fragment cost remain to be qualified.

### Explicit coastal refinement experiment

The existing 16-grid background is too coarse for the new coast. On eight aligned
100m leaves, 81,608 actual one-metre samples measured these differences between
the rendered triangle surface and the authoritative height function:

| Grid | Maximum error | Near-water maximum | RMS error | Eight-leaf triangles / geometry bytes |
| --- | --- | --- | --- | --- |
| 16 | 3.058m | 2.039m | 0.2160m | 4,560 / 198,080 |
| 32 | 0.9287m | 0.7138m | 0.05683m | 17,360 / 724,416 |
| 64 | 0.24196m | 0.16842m | 0.01455m | 67,536 / 2,760,128 |

This is numerical geometry evidence, not GPU timing or visual approval. A complete
feature-region candidate covers ten 100m leaves at 64, adding 78,720 triangles and
3,202,560 geometry bytes against their 16-grid equivalents. The final region set
is verified in the actual quadtree, including distant camera anchors, and
retains the existing 128-grid pond precedence. This is an explicit quality/cost
increase, not an unchanged-density claim or a whole-island resolution increase.
The original 18m inlet-bank transition is retained rather than smoothing the shape
merely to pass an arbitrary coarse-error tolerance. Residual contact and visible
shoreline errors remain subject to actual camera/animation review.

The complete ten-leaf follow-up covers 102,010 samples, including the edges missed
by the initial eight-leaf comparison. At 64, maximum error is 0.284562m at (396,512),
near-water maximum is 0.168418m at (440,453), and RMS is 0.014834m. Absolute geometry
is 84,420 triangles / 3,450,160 bytes. The tests bound approximation error rather
than claiming exact contact. The 16 and 32 alternatives remain rejected for this
feature's quality target; their near-water maxima are 2.03884m and 0.713809m.

The stone uses linear-space PBR colors and surface-gradient relief, not baked
illumination or physical displacement. References: [Three PBR material behavior](https://threejs.org/docs/pages/MeshStandardMaterial.html),
[Three TSL](https://threejs.org/docs/pages/TSL.html), and the installed r186
`BumpMapNode.js` surface-gradient construction. Existing terrain projection work
follows [NVIDIA texture filtering guidance](https://developer.nvidia.com/gpugems/gpugems/part-iii-materials/chapter-20-texture-bombing).

## Rebuilt spatial verification: probe40

Normal shared/client and server builds passed, followed by all three TypeScript
checks and scoped lint. The final combined root regression is 100 cases across
14 files (59 shared / 41 server), including the real occupied-spawn regression.
Spatial harness 89/89 and contact harness 54/54 also pass. Agent suite totals
overlap these checks and are not added together as unique coverage.

Actual headful Chrome/Metal WebGPU, explicit `shadows-720p60-v1`, 1280×720/DPR1,
MSAA4, lightweight diagnostics: the full spatial study passed. Whole-run status
remains **FAIL**, solely the inherited five cow-loading and fourteen dagger-fit
console errors. Zero GPU/page errors. All owned cleanup and original camera/
director restoration passed. The six terrain textures and five pond models were
served with HTTP200 and matched prelaunch byte hashes.

An independent review verified 396 source pins, 327 archives and 28 unique PNGs,
plus standalone JSON equality. All 45 geometry observations retained the exact
v3 profile: 40 base leaves, 10 coastal 64-grid leaves and two pond 128-grid leaves.
Coastal geometry is exactly 84,420 triangles / 3,450,160 bytes; pond geometry stays
66,548 / 2,690,928. No new error class or undeclared geometry increase was admitted.

Report SHA256: `27726aca7d533c544bb3f5f20bf6634bba15eb406722ff1c87201b6cf28bc27b`.
Evidence: `asset-studio/game-test-integration/compact-world-probe40`.

Two roughly ten-second scheduling windows observed render-call progress at
60.050Hz after equip and 59.601Hz after study. Progress intervals were p95 17.4ms /
maximum 17.6ms and p95 17.3ms / maximum 34.2ms, respectively. These are **not GPU
timings or presented/decoded FPS**. Lighting and camera motion differ between the
windows; they are not a matched A/B performance comparison. Cold startup retained
a 349.2ms maximum RAF interval. Population was stable within each measured window.

### Actual visual verdict and next art direction

The root and an independent visual reviewer inspected actual wide and campus-link
images. The silhouette and shared floor materials improved, but **art acceptance
still fails**: ground remains a mostly uninterrupted green carpet, turf repetition
is visible, the inlet is too geometric, canopy coverage is sparse, the north
building appears black, and pale rectangular platforms dominate the composition.
The close-up actors still need skin/metal lighting and finer shadow qualification.

An image-generated concept is retained separately at
`asset-studio/compact-island-art-direction-20260911/compact-island-target-concept-v1.png`,
with its exact built-in generation prompt in `PROMPT.md`. It is **not engine output**.
Its material/region hierarchy is a reference; generated prop counts, paths, tents
and cliffs do not override authoritative gameplay layout or resource identities.
The next bounded implementation is landform-aligned dry meadow, exposed ridge
rock and retained green preparation/grove areas through the existing terrain
layers and matching CPU/grass palette. Geometry, vegetation population, six maps,
14 surface fetches, lights and rendering passes remain fixed for that comparison.
Additional shader arithmetic must still be measured; it is not assumed free.

## Remaining gates

- Improve the visually rejected island composition from probe40; the paired
  profile, material, geometry and all three platform captures are now retained.
- Verify moving actor contact and shadow stability beyond probe41's corrected
  stationary support measurements.
- Review distant material shimmer, wind/LOD transitions, grass continuity and
  shoreline water optics. Preserve the actual launch population in comparisons.
- Finish authored ground regions, island-wide functional woodland, understory,
  lighting/environment agreement, fine shadows and off-camera casters.
- Resolve inherited cow/dagger failures; qualify animation, real agent gathering,
  reconnect/long-running preparation, sound and decoded streaming.
- Record representative CPU/GPU frame tails, loading, memory and sustained thermal
  behavior on qualified client and deployment hardware. Diagnostic sampling is
  not representative performance proof.
