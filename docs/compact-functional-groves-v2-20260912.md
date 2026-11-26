# Functional grove layout v2 — local art candidate

This installs exactly 19 qualified additions from `asset-studio/compact-resource-groves02/candidate.json`: 17 general trees and 2 oaks, comprising 9 scale-0.8 and 10 scale-1 trees. The requested 24-tree expansion was not forced. All prior 29 identities, positions, species and scales remain unchanged. The result is 48 choppable trees, not decorative copies and not launch-balance approval.

## Admission and ownership

The enclosing world configuration stays version 2. Its grove block becomes schema 2 / `compact-functional-groves-v2`, containing 35 grove anchors with a strict ceiling of 40 and only scales 0.8 or 1. Historical schema 1 / layout v1 retains cap 16 and scale 1, including its prior v4/v5 profile pairings. Layout v2 is admitted only with the unchanged terrain v5 / sculpt-v4 profile. No terrain, coastline, campus, lodge, world-area policy or source reward manifest is changed.

The full world-content identity is `198859e9e703e4a1cfd8d09b341d1fb70177a73e894dfcf149c2a529c9cba87f`. An identified world cannot hot-replace this configuration; deploy matched client/server assets and restart. The previous content identity is rejected before resource packets are admitted. No existing depletion row requires an identity or transform migration; no database rewrite is included.

| Centered owner | Prior grove anchors | Added | New grove total |
| --- | ---: | ---: | ---: |
| 3_4 | 5 | 8 | 13 |
| 3_5 | 8 | 5 | 13 |
| 4_4 | 1 | 2 | 3 |
| 5_4 | 2 | 4 | 6 |

The existing nine content owners still publish 8 seeded trees plus 35 frozen grove trees. Five authored trees remain separate. The existing `generateTreesForTile` → centered-owner batch → `ResourceSystem` path is reused without RNG, density, owner-radius or instance-ID changes. West grove metadata expands only maxX 306 → 312; this is not a world-area or custody boundary.

The entity relevance radius remains 110 m. The initial resource snapshot already sends every authoritative resource row, independently of entity relevance. The real full-core socket fixture now verifies 59 rows: 48 trees and the unchanged 10 ore / 1 fishing resource. Local trees require current-session authoritative availability before publication; expired wall-clock deadlines do not invent respawns.

## Verified scope and remaining gates

- Real CPU World/Terrain/ResourceSystem tests verify the exact 48-tree census, prior 29 transforms, the frozen old 16 plus exact new 19, species rewards and 80-tick respawns, centered owners, stationary identity, owner unload/reload and scale-0.8 teardown. Stump scale remains the existing manifest value 0.1 multiplied by the anchor scale.
- All 48 trees have a completed bounded BFS route from the bank-front start through actual collision flags and edge checks; all 19 additions have four free cardinal approaches. This is not a moving-player/native navigation demonstration. Station-model and wind-expanded visual clearances remain the independently retained offline measurements, with actual service-clearing regression maintained separately.
- The small distant tree is tested with snapshot before and after local registration, depleted unload/reload, reconnect, stale-session writes, repeated registration and authoritative respawn. Replayed real server owner batches preserve pre-existing and smaller-tree availability/depletion deadlines. The loopback test uses real Socket serialization before socket-map registration; it performs no SQL.
- Existing cold-load tree pool/lifetime tests are rerun, but no new scale-specific GPU pool/proxy, native appearance, performance, live harvest or PostgreSQL restart qualification is claimed. Existing durable-state policy is unchanged; persisted restart and native rendering remain explicit gates.

The additional 19 selected model variants total 113,647 source LOD0 triangles before shadows and overdraw. Actual loaded LOD/material/instance costs and visual grouping require the next native review; tree availability and travel-time economics have increased even though per-tree rewards and lifecycle rules did not change.
