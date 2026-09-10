# Compact agent island: visual and implementation plan

Status: **planned, not implemented or qualified**. Source audit and revised user direction: 2026-09-10. The compact agent island is the only target world; the large island does not need preservation or a separate playable preset. Build a cohesive island with banks, gathering resources and workstations beside the duel arena. A roughly **300–400 m footprint is an initial authoring candidate**, not an approved size or performance budget. Terrain shape, texture quality, shoreline, layout and vegetation may be substantially rebuilt, not merely recolored.

## Replacement scope and safety

- Replace the large-world terrain and content configuration with one coherent compact world once qualified. Version the world/profile and migrate persisted spawn/player coordinates deliberately; preservation of the old playable island is not an acceptance requirement. Never delete unrelated user data or databases as a shortcut.
- Preserve the original avatar, equipment, skin/rest/weight contracts and existing gameplay/custody rules. This plan does not authorize grip work or avatar remodeling.
- Keep resource, bank, shop, station and arena identities authoritative. Moving scenery alone must not create fake functional resources or bypass ordinary inventory transactions.
- Require WebGPU. Do not add WebGL fallback, hide missing content, weaken readiness checks or promote an unqualified diagnostic world to the default.
- Use explicit shared configuration and measurable acceptance for the new island. Replacing old constants or terrain algorithms is permitted when all authoritative, worker and rendered consumers are updated together and tested. Test-only coordinate or readiness overrides are not implementation.

## Verified starting point

Paths below are relative to this repository unless an adjacent `asset-studio` evidence path is explicit. These are source settings, not a new runtime measurement.

| Subject | Current evidence and implication |
| --- | --- |
| Arena | `packages/shared/src/data/arena-layout.ts` and `packages/server/world/assets/manifests/duel-arenas.json`: six 20×24 m arenas, 4 m gaps, 44×80 m grid at X340–384/Z394–474; whole zone X316–420/Z348.5–489. Lobby spawn is (385, 374). Retain this positioning initially. |
| Preparation hub | `packages/server/world/assets/manifests/world-areas.json`: Central Haven occupies 36×36 m at the origin; training/resources occupy 72×72 m; fishing pond is immediately south. Bank, stores, furnace, anvil, range, prayer/runecrafting altars, gathering and training actors already exist. Origin-to-lobby distance is about 535 m in plan view, not a measured walking route. |
| Terrain | `packages/shared/src/systems/shared/world/TerrainSystem.ts`: 100 m chunks, 100×100-chunk world envelope, default seed 0, view radius 5 chunks, visual quadtree enabled. `TerrainHeightParams.ts`: actual island-mask radius 2,419 m, falloff 450 m, ocean floor Y2.5 and maximum-height parameter 50. `GameConstants.ts`: water Y16 and 1 m movement tiles. The 10 km world envelope is not the island's land diameter. |
| Configuration gap | `world-config.json` is loaded by `packages/shared/src/data/DataManager.ts`, but current `TerrainSystem` does not consume its terrain configuration. Its seed comes from `world.config.terrainSeed`, `TERRAIN_SEED`, then 0. Manifest-only resizing is insufficient. Manifest maximum height 30 and fog 150–350 differ from height parameters and `FogConfig.ts` fog 400–800. |
| Profile isolation hook | `DataManager.ts` checks `ASSETS_DIR/manifests` on the server; clients fetch manifests from their asset base URL. Both sides must resolve the same island profile and content, not silently fall back to different roots. |
| Broadcast omission | `packages/shared/src/runtime/clientViewportMode.ts` currently disables exploration resources, world entities, local physics and procedural exploration systems for stream/spectator views; network admission is player-only. This saves arena cost but would omit preparation content. |
| Existing optimization | `DuelArenaVisualsSystem.ts` uses instanced architecture and emissive braziers rather than many point lights. `TerrainSystem.ts` has worker generation and quadtree work limits; streaming uses resolution 16, one root, at most one synchronous chunk and two assemblies per frame. `LODConfig.ts`, animation LOD and spatial simulation already exist. These mechanisms are reusable, not proof of island performance. |

Lighting, terrain materials and composition must be developed together; further palette-only diagnostics must not block actual island construction. The earlier `shadows=none` path incorrectly removed directional sunlight; that behavior has now been corrected separately. It is not evidence that shadow maps or a new island are approved.

Retained [session03 wide-front metadata](../../asset-studio/game-test-integration/avatar-render-review01/session03/wide-front.json) explicitly records **night**, `dayPhase=0.9840922503`, `dayIntensity=0`, and `SunLight_NoShadows`; do not relabel that image as noon. Its teal ambient/hemisphere palette is consistent with `packages/shared/src/systems/shared/world/LightingConfig.ts`, not evidence that terrain became water. `DAY_CYCLE.DURATION_SEC` is 240 seconds, so uncontrolled before/after images can change lighting substantially within one review.

## Foundational checkpoint — island gates still open

The validated `packages/shared/src/systems/shared/world/WorldTerrainProfile.ts` contract has **19 passing tests**, but is **unconnected** to terrain consumers. It provides validation, canonical serialization and identity input for the selected parameters only. There is no compact numeric preset, compact content selection, default change or consumer integration. CPU/worker/GPU terrain parity remains unresolved; the contract does not establish it.

The opt-in lighting foundation has focused coverage: floor shadow-receiver fix **2 tests**, borrowed PMREM material environment **21 tests**, and bounded directional shadow **9 tests**. The full shared TypeScript check and **62 tests across six files** passed. These checks qualify the tested helpers, not the island or a new default lighting configuration.

The bounded actual WebGPU **run02** completed **20 cases with zero recorded errors and complete cleanup**. It includes the visible avatar; run01's retained harness bounding-box failure is not a successful visual result. At fixed **1280×720, DPR 1**, run02 rendered-interval p50 was approximately **16.7 ms** and p95 **17.4–17.9 ms** across the compared cases. These are rendered-interval measurements, **not GPU timestamps or representative full-gameplay acceptance**.

The balanced lighting candidate improves the compared presentation, but the shield remains dark, night fences remain weakly readable, and the studio reflection is unsuitable. No candidate is a new default or a complete visual pass. See the retained [world-lighting checkpoint evidence](../../asset-studio/game-test-integration/world-lighting-review01/RESULT.md) for the matched cases, limitations and cleanup.

## Sequential implementation tasks

### 1. Verify lighting and material presentation at fixed cameras

- [ ] Retain a baseline with exact source/build hashes, camera matrices, renderer profile, resolution/DPR, exposure, tone mapping, day phase, lights and material/map values.
- [ ] Capture the same ground-level, arena-wide and preparation-facing cameras at explicit noon and night; include a neutral material reference, authored avatar skin, cloth, metal, stone, vegetation and terrain.
- [ ] Confirm disabling shadow maps leaves directional illumination present; distinguish no-shadow lighting from absent sunlight. Compare any shadow-enabled alternative separately with measured cost.
- [ ] Review day/night color, PBR map decoding, roughness/metal response, terrain shading and fog together before changing layout or textures. Do not compensate for a lighting or color-space defect by painting assets darker/lighter.
- [ ] Resolve the existing stylized-world versus authored-PBR lighting mismatch explicitly. `Environment.ts` currently clears `scene.environment` when using the procedural sky; the water's planar reflection is not a general material-lighting solution. Compare a bounded, shared reflection/lighting environment for skin, eyes and metal without rebuilding it every frame or breaking water. Record memory, warm-up, ownership and measured GPU cost before selecting an approach.
- [ ] Retain matched before/after images and actual scene metadata. Decide a coherent palette and readable lighting direction; do not claim a complete art pass from a single noon screenshot.

References: `packages/shared/src/systems/shared/world/{Environment,LightingConfig,SkySystem,FogConfig}.ts`, `packages/shared/src/systems/client/ClientGraphics.ts`, and the retained [session03 images and reports](../../asset-studio/game-test-integration/avatar-render-review01/session03/).

### 2. Establish one explicit shared island profile

- [ ] Define one validated compact profile for terrain bounds/center, shoreline/falloff, height, water, seed and explicit content selection. Qualify the replacement before default promotion; no enduring large-world preset is required.
- [ ] Propagate that same profile through server height/collision/navigation, main-thread terrain, worker generation and GPU/shader calculations. Account for constants injected into worker/shader code; changing a JSON file or one CPU path alone is not sufficient.
- [ ] Make the chosen profile/content version observable on both client and server and fail on mismatches or unsupported values. Migrate saved coordinates/spawns safely to the compact world instead of maintaining two playable maps.
- [ ] Verify CPU/worker/GPU height agreement, shoreline classification, flat-zone application and tile-boundary continuity before population or visual dressing.

References: `DataManager.ts`, `TerrainSystem.ts`, `TerrainHeightParams.ts`, `packages/shared/src/utils/compute/shaders/heightmap.wgsl.ts`, `packages/shared/src/systems/shared/movement/TileSystem.ts`, and `packages/server/src/startup/world.ts`.

### 3. Bring the existing preparation hub beside the retained arena

- [ ] Block out the initial 300–400 m island footprint around the retained arena complex. Choose the final outline from navigable space, sightlines and measured cost, not that provisional number alone.
- [ ] Relocate the existing compact hub as a coherent cluster: bank/shops at the central route, forge and workshop together, woodland/mining at the perimeter, pond/cooking nearby, with training separated from safe circulation.
- [ ] Keep stable resource/station identities and actual recipes, shops, water bodies and custody policies. Update world-area bounds, flat zones, pond bed/water/shore access and spawn coordinates together.
- [ ] Keep lobby/hospital, arena bounds, spawn/forfeit positions and server movement consistent. Arena grid data is configurable, but lobby/hospital still have direct `arena-layout.ts` consumers; do not relocate only one representation.
- [ ] Validate all real agent routes through the 1 m navigation grid, including station approach tiles, water/slope rejection, building entrances, arena ingress and recovery after interruption. Do not replace travel with teleport or remote bank access.
- [ ] Review the complete silhouette and connected ground-level route: cohesive stone/wood/metal palette, readable landmark hierarchy, restrained vegetation, clear shoreline and no accidental empty expanse. Reuse instancing and shared materials for repeated structures.

References: `world-areas.json`, `stations.json`, `gathering/`, `stores.json`, `recipes/` under `packages/server/world/assets/manifests/`; `packages/server/src/shared/PhysicalBankAccess.ts` preserves the server-owned bank target and two-tile Chebyshev interaction boundary.

### 4. Admit preparation content without re-enabling the whole exploration world

- [ ] Add explicit island/phase-scoped client admission for the authoritative preparation resources, stations, NPCs and visible activity required by the camera and agents.
- [ ] Preserve the existing arena-only broadcast optimization where appropriate. Do not globally turn on all procedural towns, POIs, vegetation and world entities merely to make a bank visible.
- [ ] Test transition from preparation to arena and back, including network creation/removal, gathering state, workstations, inventory custody and camera continuity. Functional objects must remain discoverable and interactable when their rendering changes LOD.

References: `packages/shared/src/runtime/{clientViewportMode,createClientWorld}.ts`, `packages/shared/src/systems/shared/entities/ResourceSystem.ts`, and `packages/server/src/systems/StreamingDuelScheduler/`.

### 5. Tune dense-island performance against evidence

- [ ] Retain the existing-world/arena baseline as evidence and compare the compact candidate on the same hardware, WebGPU backend, resolution, DPR, actor count, equipment and representative day/night workload. A retained baseline capture is not a requirement to keep the old world playable.
- [ ] Measure frame-time p95/p99, long frames, draw calls, triangles, memory/residency, terrain generation work, server ticks and navigation responsiveness during gathering, preparation, combat and cleanup.
- [ ] Derive island-specific LOD/density/update budgets from that evidence. Current tree LOD0 reaches 800 m and ordinary resources hundreds of meters, so an entire small island could remain full-detail; nearby AI and animation can also become active simultaneously.
- [ ] Tighten only demonstrated cost centers while preserving readable silhouettes, useful resource visibility and animation. Prefer shared materials/instancing and bounded terrain work; do not blindly lower every quality setting or introduce unmeasured lights/postprocessing.
- [ ] Re-run matched visuals and workload after tuning; retain failures and explicit tradeoffs. Do not infer game-performance approval from geometry counts or static screenshots.

References: `packages/shared/src/systems/shared/world/LODConfig.ts`, `packages/shared/src/constants/GameConstants.ts`, `packages/shared/src/utils/rendering/AnimationLOD.ts`, `packages/shared/src/systems/client/StreamPerformanceTelemetry.ts`, and explicit 720p60/720p30 profiles in `clientViewportMode.ts`. These existing profiles are test contexts, not newly validated island budgets.

## Five acceptance gates

1. [ ] **Coherent replacement and safe migration:** compact manifest/profile versions agree across client/server; persisted spawns/coordinates are migrated safely; avatar/equipment and custody contracts remain intact. The old large island is not a required preset or deliverable.
2. [ ] **Functional proximity/navigation:** real agents can gather, bank, shop, produce, train and reach the arena through ordinary authoritative movement and transactions; no remote-access or teleport shortcut substitutes for a working compact layout.
3. [ ] **Terrain/physics agreement:** CPU, worker, GPU, water, flat zones and collision/navigation agree at shores, doors, stations, spawns and chunk boundaries; no underwater workstations or inaccessible approaches.
4. [ ] **Visual cohesion/readability:** matched noon/night and route views show coherent materials, lighting, shoreline, landmarks and preparation/arena interfaces. No missing resource content, camera-obscured action or unexplained day/night comparison.
5. [ ] **Measured performance/lifecycle:** representative interactive and broadcast workloads meet explicitly selected targets without an unaccepted regression from the matched baseline; report frame/tick distributions, memory and teardown, not an invented universal budget.

All tasks and gates above remain open. The foundational contract, opt-in helpers and bounded lighting checkpoint do not complete the compact island, content selection, art approval, gameplay qualification or performance acceptance.
