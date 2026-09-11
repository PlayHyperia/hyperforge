# One arena and a composed compact world

User direction, 2026-09-10: **one duel arena, not six**. The entire 3D world
still needs a substantial quality improvement. This is the next implementation
scope; checked items below have implementation evidence. Historical six-ring
captures remain historical evidence; do not overwrite them.

Update2026-09-11: the one-arena structural candidate passes focused shared/server
regressions and is visible in actual WebGPU probes29/30. Whole integration and
art/performance approval remain open; see
[compact presentation qualification](compact-presentation-qualification-20260911.md).

## 1. One authoritative arena

- [x] Set shared `arena-layout.ts` and both arena/world manifests to one column,
      one row, one arena, ID1. Initially retain its 20x24m combat footprint
      (x340–360, z394–418), not hidden off-camera backup rings.
- [x] Remove IDs2–6 and their derived floor, fence, brazier, pillar, perimeter
      collision and combat-zone ownership. Three authored floor owners must remain:
      arena1, lobby and hospital. Generic pool test fixtures are not playable content.
- [x] Remove 2x3 parser fallbacks and make combat containment enumerate the actual
      configured arenas. Derive zone bounds from the full union of all three floor
      rectangles on both axes; current max-bound shortcuts happen to fit six rings.
- [ ] Preserve ID1's streaming reservation. While streaming owns the sole arena,
      reject ordinary challenges early with existing `NO_ARENA_AVAILABLE` and a
      visible explanation, before walk-to-target, pending challenge or session
      creation. Recheck after delayed movement and retain final atomic allocation.
      With streaming disabled, ordinary duels may allocate/release the same arena.
      No new queue, settlement behavior or competing reservation is needed.
      Server rejection/allocation implementation is tested; finishing both-client
      consumed-invite notification and final-acceptance reset remains open.
- [x] Reduce the campus grade and area together. A count-only reduction with
      existing landmarks gives x316–420,z348.5–433, center368,390.75 and104x84.5m.
      Treat that as an initial safe reduction, not the final composition. Preserve
      the common grade28.419301523097687 and verified platform offsets initially.
- [ ] Before relocating/shrinking the lobby, contain winner/loser returns and
      ModelAgentSpawner recovery positions in its actual floor. Preserve custody,
      safe-zone/death/item-drop authority and all preparation interaction targets.
- [ ] Retain the six walking connections: they connect distinct preparation
      stations and are not six-arena infrastructure. Derive moved endpoints and
      revalidate water/floor crossings, reachable approaches and camera framing.

Required regressions include arena grading/pool collision, DuelSystem streaming
and ordinary admission, duel-manifest combat containment, actual terrain workers,
grass snapshots, visual floor/shadow/depth ownership, paths, profile/content
identity, camera, scheduler occupancy/autonomy/restore, manifest verification and
launch preflight. Removed IDs and their former wall/footprint centers must fail
arena allocation/combat ownership. No persisted wager or user database deletion.

## 2. Build the whole scene, not another empty lawn

Actual probe16 showed only twelve grass clumps at most and none in its observed
preparation-campus/pond-bank regions. Streaming spacing is currently
0.7x4x5=14m before further rejection. The decorative vegetation manifest defines
only mushrooms; that is separate from the existing harvestable resource trees.
The choppable resource trees must populate the island. Do not solve composition
with a second decorative tree population or duplicate resource visuals. Grass
coverage and resource-tree distribution require distinct audits and acceptance.

- [ ] Finalize the compact playable footprint around the one-arena campus and
      the existing preparation content (approximately x314–386,z284–356). Arena
      count alone does not change the current radius165/400m envelope. Change
      island center/radius/falloff/envelope coherently with all admitted anchors,
      authoritative worker/collision/navigation sampling and ocean buffer checks.
- [ ] Strengthen primary landforms: a western rocky ridge, asymmetric coastal
      headlands and a sheltered preparation clearing. Existing broad gentle hills
      rarely reach the steep-rock material threshold. Do not scatter extra noise.
- [ ] Form a small shared stone/timber preparation village around bank,
      furnace/anvil and cooking, with readable clear paths to the single arena.
      Qualify canopy flue clearance, colliders and spectator occlusion before use.
- [ ] Compose uneven resource-tree groves and outcrop groups with intentional
      sightlines and gaps. Spread the existing choppable trees across the compact
      island using their authoritative resource placements, not decorative spawns.
      Audit candidate western/eastern belts and freed southern space against the
      final footprint; never treat suggested rectangles as automatic spawn approval.
      Preserve species/tier access and explicitly review any resource-count/economy
      changes. Require visible mesh, selectable target, collider, depletion/regrowth
      and agent behavior to remain synchronized through harvesting and reconnect.
      Reuse existing resource batching/collision. Put
      noninteractive coastal rocks only in proven nonwalkable areas; no walk-through
      trunks beside agent routes.
- [ ] Make grass visible in selected meadow/grove regions using the existing
      workers, retained-surface projection, tickets and bounded GPU uploads. Keep
      authored paths, floors and exact water exclusion empty. Require nonzero actual
      regional coverage, not an overall system-ready flag.
- [ ] Evaluate selected online textures/foliage/rocks for real visual benefit,
      source rights, silhouettes, alpha, normal/roughness response and residency.
      The CC0 Fern02 is an integrated candidate; the sorrel trial remains separate.
- [ ] Admit population definitions through `WorldContentIdentity` if
      `vegetation.json` becomes launch-critical; it is currently absent from that
      digest. World-area resource changes already require identity and gameplay
      regressions. Avoid silently changing the preparation economy.

Withdraw the earlier proposal for 24 additional scenery trees: resource-tree
placement and its total visible population must be audited first. A separate
proposal for up to32rocks(24medium,8large) and2000resident grass clumps remains
subject to real scene review, navigation and measured cost, not spawn approval.
Measure the actual resource-tree LOD/batching path before changing its thresholds;
the decorative tree LOD table is not proof of effective resource-tree behavior.
Tune compact transitions, texture sharing, shadow cost, draw calls and memory
against that authoritative population without silently reducing resource supply.

## 3. Acceptance from the actual experience

Resource-tree audit follow-through is recorded in
`research/terrain-vegetation-assets-20260910.md`. Five explicit preparation trees
coexist with active procedural resource trees; five is not the total live count.
Before expanding their distribution, verify generation/unload tile ownership,
Y after X/Z snapping, persistent-ID uniqueness/relocation, station/building
clearance and reachable harvesting adjacency. The current depleted-tree batch
dissolves instead of swapping the declared stump mesh and retains collision;
qualify that complete lifecycle rather than assuming a stump transition works.

- [ ] New immutable WebGPU close/hub/approach/wide views show one ring, a coherent
      village and landscape rather than isolated props on a flat grass patch.
- [ ] Visually inspect texture scale/repetition, wet banks, roots/ground contact,
      silhouette, material consistency, shadows, foliage shimmer and agent/UI
      readability. Passing source/receipt tests does not pass this visual gate.
- [ ] Prove real gathering/banking/crafting/return/combat routes, denied obsolete
      arena IDs, contention and ownership transitions without custody regressions.
- [ ] Verify moving cameras, near/far LODs, daylight/night, multiple agents,
      reconnect/restart and stream continuity; measure representative CPU/GPU frame
      distributions, loading and memory at unchanged resolution/quality.

Cow asset404, canonical dagger fit metadata, hospital striping, blue/mismatched
avatar presentation, equipment completion and the broader reliable agent/SOL
launch gates remain open. Neither this plan nor a prettier screenshot clears them.
