# Hyperia Character Motion, Soundscape and Broadcast Quality

## Recommended production direction

Hyperia should build a tightly integrated character-and-sound presentation layer around its authoritative simulation, not replace that simulation with animation or make every frame depend on an LLM. Agents choose intentions, equipment and tactics; validated server actions determine movement, damage, resources and round state. Animation, effects and audio make those real actions readable. They must never invent a successful hit, resource reward or winner.

The highest-return sequence is one canonical modular character rig; a small, excellent locomotion/combat/preparation clip set; explicit contact and action markers; a layered island soundscape; and a measured, synchronized broadcast mix. The current code provides substantial pieces of this foundation. It does not yet establish complete visual, acoustic or long-duration production quality.

An integrated CC0 character/animation family is worth a controlled comparison with the existing authored avatar. It is not an automatic replacement: a different skeleton would invalidate fitted armor and hand attachments until recalibrated. Full motion matching, neural motion generation and a new audio middleware layer are alternatives, but are not prerequisites for this compact, single-arena experience.

## Implementation baseline

The following observations concern the local implementation inspected on 10 September 2026, including work in progress. Three.js is installed at **0.183.2**. These are source findings, not newly executed runtime, listening or performance tests.

| Area | Actual foundation | Important remaining limitation |
| --- | --- | --- |
| Avatar | [createVRMFactory.ts](/Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/extras/three/createVRMFactory.ts) shares geometry/textures while cloning pose ownership; applies mixer animation, additive hit reaction, normalized-to-raw humanoid propagation, then skeleton updates. | Preserve that order when introducing IK or additional layers. Factory distance pacing and entity animation LOD both need examination before claiming hero motion updates every displayed frame. |
| Retargeting | [Authored38ArmRetarget.ts](/Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/extras/three/Authored38ArmRetarget.ts) contains explicit calibrated arm transforms; a separate [client retarget helper](/Users/lucid/Documents/hyperia/hyperia-implementation/packages/client/src/utils/vrmAnimationRetarget.ts) exists. | A new rig is a versioned asset migration, not a filename swap. Avoid making several independent corrections compensate for one wrong rest pose. |
| Equipment | [EquipmentVisualHelpers.ts](/Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/client/EquipmentVisualHelpers.ts) validates fitted matrices, skinned gear, rig fingerprints, grip contacts and two-hand metadata. [EquipmentVisualSystem.ts](/Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/client/EquipmentVisualSystem.ts) owns loading, attachment, presentation and cleanup. | Metadata validity cannot certify visible grip, silhouette, occlusion or deformation throughout motion. Test the actual loaded avatar and gear together. |
| Combat | [CombatAnimationManager.ts](/Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/combat/CombatAnimationManager.ts) chooses weapon/spell emotes and tick-aligned resets. [StreamingDuelDamageAuthority.ts](/Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/combat/StreamingDuelDamageAuthority.ts) bridges committed damage and duel authority. | The reset helper assumes broad one-/two-second clip classes rather than per-clip authored markers. `CombatAnimationSync.ts` contains scheduling machinery, but the inspected source search found only its barrel export, not a runtime construction/import; do not count it as an integrated timing solution. |
| Audio | [ClientAudio.ts](/Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/client/ClientAudio.ts) owns music/SFX/voice buses, listener updates and actual master-mix capture. | Initial bus values use `world.prefs?.music || 0.5` and equivalent SFX/voice expressions: an intentional numeric zero becomes 0.5. This needs a focused mute-preference correction and real reload test. |
| Combat sound | [CombatAudioSystem.ts](/Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/client/CombatAudioSystem.ts) preloads six melee impacts, caps eight active impacts, uses HRTF/inverse distance and cleans up nodes. | Successful melee only; `source.start(0)` occurs on receipt of damage. Deterministic variation is not event deduplication. Ranged, magic, misses, armor blocks, tools and footsteps need distinct semantics. |
| Music | [MusicSystem.ts](/Users/lucid/Documents/hyperia/hyperia-implementation/packages/shared/src/systems/shared/presentation/MusicSystem.ts) selects normal/combat tracks, avoids recent selections and schedules gain crossfades. | Entire tracks become decoded AudioBuffers. Audit memory, overlapping async loads, destruction during fades, camera/editor preferences, and whether the selected stream phase—not unrelated off-camera combat—owns musical intensity. |
| Broadcast | [browser-master-audio-capture-source.ts](/Users/lucid/Documents/hyperia/hyperia-implementation/packages/server/src/streaming/browser-master-audio-capture-source.ts) taps the master mix through an AudioWorklet; [rtmp-bridge.ts](/Users/lucid/Documents/hyperia/hyperia-implementation/packages/server/src/streaming/rtmp-bridge.ts) sends PCM to FFmpeg with bounded transport/restart handling. | PCM activity is not proof of intelligible content or synchronization in the final decoded viewer stream. Silent fallback must remain unhealthy, never satisfy sound readiness. |

## Canonical rig and modular equipment

### Preserve one deformation contract

glTF skins associate joint indices with inverse-bind matrices in a defined order; compatible-looking bone names alone do not establish compatible deformation. Its animation channels and skinning are useful interchange primitives, not a complete equipment or gameplay system.[^1] Three's r183 `SkeletonUtils` provides skeleton cloning and clip retargeting, but application-specific rest-pose, hip, scale and naming choices remain necessary.[^2]

Recommended asset contract:

- One approved body proportion, scale, rest pose and bone-axis convention for the launch kit. Keep the current body unless the controlled alternative demonstrably improves it.
- A rig fingerprint tied to rest transforms, hierarchy, joint order and export version. All deforming armor is bound to that same rig. Rigid helmets or props use declared sockets; deforming garments do not masquerade as rigid attachments.
- Stable named mesh regions for head/ears, torso, upper/lower arms, hands, pelvis/underwear and upper/lower legs. Equipment declares exactly which covered regions to hide. Partial helmets retain exposed ears; fully enclosing helmets hide covered ears. Unequipping restores the same regions without deleting or altering the body.
- Shared grip families specify handle radius, hand contact location, forward/cutting direction and roll. Sword, axe, pickaxe and hammer may share a handle convention while retaining different validated working directions. Bows, shields and two-hand tools require additional anchors; one universal transform is insufficient.
- Metal variants reuse geometry and qualified material parameters. Do not duplicate models merely for bronze/iron-style color variants or modify a shared material in a way that recolors another agent.
- A declared LOD/material/texture budget for the complete equipped character, not just its naked body. Keep independent skeleton poses while sharing immutable geometry and textures.

The acceptance object is a **moving, equipped character**: hands closed around the correct handle, weapon working edge facing correctly, shoulders and knees bending without armor penetration, shorts hidden only beneath covering leg gear, and no visible skin-color change on equip. A bone-space distance check alone can pass while a blade is backward or fingers visibly float.

### Asset options and licensing

| Candidate | Verified provider information | Recommendation and qualification cost |
| --- | --- | --- |
| Existing authored avatar/gear | Local rig-specific retarget and fit contracts already exist. | Baseline. Preserve source and renders. Finish dynamic fit evidence before broad replacement. |
| Quaternius Universal Base Characters + Modular Character Outfits—Fantasy | Provider lists CC0 humanoid bases, average approximately 13k triangles; matching outfits comprise 12 sets/62 parts with compatible rigs and three texture variations. Free Standard tiers exist, while source/full tiers differ.[^3][^4] | Best controlled external comparison. Test one regular-proportion body, one full armor set and existing weapon family first. Provider compatibility with named engines is not Three/VRM qualification. Do not promise every advertised part or `.blend` file is free. |
| Quaternius Universal Animation Library | CC0; current provider changelog describes root-motion/no-root-motion variants, synchronized directional starts and prior elbow/scale/frame-rate fixes. Standard is free; Pro/Source are separate tiers.[^5] | Preferred initial motion candidate. Pin exact release and verify actual clips in that tier. In-place variants fit server-owned displacement. Treat the June 2026 fixes as reasons to check versions, not evidence the local rig needs no cleanup. |
| Quaternius Universal Animation Library 2 | Complementary CC0 library advertising 130+ motions, including farming, fishing and split combat hits/recoveries; free Standard and paid Source listings; displayed update 5 July 2026.[^27] | Particularly relevant to preparation and tool-use gaps. Inspect the actual free-tier inventory before promising all advertised motions. Full combo clips must not override independent server action legality. |
| Mixamo | Adobe states free access with an Adobe ID, commercial project use and bipedal humanoids only. Separate additional terms prohibit specified uses of service outputs in creating/training/testing/improving AI systems.[^6][^7] | Not the default for an agent-centric product or public authoring repository. Obtain qualified rights review for the exact use and distribution before adoption; this report does not resolve legal applicability. It is not CC0 and is not a quadruped solution. |

Maintain a per-file provenance manifest: original provider URL, creator, release/download date, license text/version, original hash, derived hash, edit history and public/private distribution decision. A page-level license check is not a substitute for verifying the actual downloaded archive later. None of these external files has been downloaded, rig-tested or acoustically approved for this report.

## Motion quality and authoritative action timing

### Locomotion and turns

Use server-approved planar velocity and facing as inputs to an eight-direction locomotion blend. Compute local forward/sideways velocity relative to body orientation; a ranged agent retreating while aiming should visibly backpedal or strafe, not play a forward walk while sliding backward. Separate travel heading, body facing and aim within bounded joint limits. Choose turn-in-place clips when near stationary, and directional starts/stops for abrupt navigation changes.

Three `AnimationAction` supplies weights, playback scaling and crossfades; these are sufficient primitives for an initial controller, but do not themselves implement a blend tree, foot phase matching or interruption policy.[^8] Build those policies explicitly and test variable frame deltas. Normalize blend weights; keep gait phase consistent; allow modest speed adaptation within each clip's useful range, selecting another gait instead of stretching one walk excessively.

Do not apply both network displacement and exported root translation to the scene root. Retain in-place body motion, with a visual child transform for bounded correction if necessary; the authoritative root owns collisions and range. Daniel Holden's displacement analysis describes the underlying responsiveness-versus-motion-contact tradeoff: unconstrained data-driven drift can disagree with the simulation, while snapping the visual model directly onto code movement can expose foot sliding.[^9] The recommended launch choice is controlled simulation displacement plus authored directional motion and small contact corrections.

### Foot contact and terrain

Foot locking needs contact intervals, not merely a raycast that drags both feet toward the ground every frame. Holden's implementation separates leg solving, runtime contact locking and offline contact cleanup; contact labels inferred from velocity/height still need human validation.[^10] Use that design principle, not unreviewed wholesale code transplantation.

For Hyperia, import contact markers with each clip. During planted phases, keep a bounded toe/heel target on the retained visible ground or authored floor; release smoothly into swing. Limit pelvis correction, knee extension and slope adaptation; reset locks on teleport, death, rig replacement and large authoritative reconciliation. Update final raw-bone matrices only after the chosen pose/IK order is complete. Reject degenerate limbs and non-finite targets.

Three's CCDIKSolver is an available bounded-chain option with joint constraints and adjustable iterations.[^11] A small analytical two-bone leg solver may be easier to control for two hero characters. Neither option fixes poor source animation or wrong rest matrices. Prefer offline cleanup of repeatable errors and reserve runtime IK for terrain adaptation. Evaluate the two fighters and the current preparation subject at displayed frame cadence; keep existing lower-frequency/frozen tiers for genuinely distant characters.

Animation source quality itself matters. Holden's analysis shows how rest-pose errors, coarse temporal sampling and quantization can survive through a sophisticated controller.[^12] Preserve original sampling/precision during authoring and validate export compression numerically and visually. Do not upsample a weak clip and label it higher quality.

### A small complete motion set

The initial library should cover directional walk/run/retreat, start/stop and turn; relaxed/combat idle; melee swing/thrust/heavy strike; ranged nock/draw/release; cast wind-up/release/recovery; hit/block/death; equip/unequip; eat; mining/chopping; smithing/forging; fishing; and bank interaction. Use separate clips only where silhouette or mechanics justify them. Reuse a polished family across metal variants.

Each clip needs semantic metadata: rig/version, intended equipment family, duration, root-motion policy, loop/phase, foot contacts, hand contacts, anticipation, release/contact, recovery and interruption rules. Audit every launch action against this list. Missing clips remain visible checklist gaps rather than silently using an unrelated emote.

### One presentation event contract

Recommended events carry stable action ID, duel/round ID, actor/target, authoritative sequence/tick/time, action kind and outcome. The server owns start/release/committed-impact distinctions. Presentation metadata maps those events onto clip markers. For projectiles, release is not impact; a miss must not play a successful armor hit. A gathering swing is not evidence of a granted resource.

Schedule the visible clip and sound against the same presentation timeline, with bounded interpolation delay. Late arrival may seek into the appropriate clip phase or omit an expired cosmetic flourish, but may not fabricate anticipation for an already committed outcome. Deduplicate by action identity, not by a hash used for sound variation. Reset queues by connection/round generation; stale packets cannot replay a prior duel's sounds or rewards.

The LLM chooses strategy and macro parameters; reliable server-validated actions execute promptly. Macros may select movement, maintain distance, switch styles and request attacks within existing rules. They must not gain hidden information or let animation state decide combat legality. Readability should improve agent agency, not conceal it behind scripted choreography.

### Alternatives after the first complete controller

The launch recommendation is a clip/state controller with directional blending and bounded IK because its action inventory and interruption rules are inspectable. A motion-matching controller becomes attractive if that approach leaves conspicuous start/turn/transition artifacts despite excellent source clips; it requires a coherent motion database, trajectory features, contact-aware transitions and measured search/storage cost. Three's mixer is not that database or controller. Neural motion generation adds model/runtime and failure-mode qualification, and should stay outside the authoritative action path. These are engineering tradeoffs, not claims that any approach automatically produces superior art.

## Island soundscape, combat and preparation audio

### Mix structure

Retain one owned AudioContext and extend the existing buses with world ambience and interface/announcement routing where needed. Keep a separately configurable broadcast mix so a local workstation mute does not unexpectedly silence the stream, while viewer mute remains respected. This is an explicit product setting, not an autoplay bypass. Browser unlock, suspend/resume and sink failures remain visible states. MDN recommends user controls and deliberate handling of context activation and scheduled AudioParam changes.[^13]

Recommended layers:

| Layer | Sonic purpose | Scope and restraint |
| --- | --- | --- |
| Island bed | Quiet wind, distant leaves, distant coast; day/night variation. | One or two low-level stereo beds, not dozens of HRTF emitters. Avoid audible short loops. |
| Local ambience | Pond water, forge fire, foliage and occasional animal/bird detail. | A few admitted zone emitters, smoothly attenuated and virtualized when inaudible. Do not attach an ocean roar to a quiet pond. |
| Preparation | Footsteps by actual surface; wood/stone/metal tool impacts; bag/bank/equip actions; fire/cooking. | Tie contacts to visible actions and successful outcomes separately. Do not play repeated tool hits while agents are paused or pathfinding. |
| Combat | Weapon motion, release, distinct material impact, block/miss, restrained hit reaction. | Preserve attack identity and readable dynamics. Important hero actions outrank distant incidental sounds. |
| Round/UI | Betting state, countdown, lock, start, result, reconnect warning. | Clear but sparse; never misleading about settled/final outcomes. Accessibility cannot depend on hearing alone. |
| Music | Preparation calm, bounded buildup, fight tension, short result release. | Phase-driven, with real quiet space. Duck beneath critical cues. Do not restart a track on every minor hit or camera cut. |

Web Audio provides position, direction, distance and panning controls; HRTF and equal-power spatialization are different choices.[^14] A free-flying stream camera should not make the fight inaudible just because an overview moves far above it. Define the broadcast listener deliberately—an arena/preparation subject anchor with camera-relative orientation is a candidate—and crossfade listener transitions. Test headphones, speakers and mono. HRTF is not automatic occlusion, obstruction or environmental reverb.

For the initial compact island, use a small number of bounded, low-frequency obstruction checks only if audible tests justify them. Avoid a full ray-traced acoustic simulation. Pool reusable gain/panner routing where practical, but create a fresh AudioBufferSourceNode for each one-shot; source nodes cannot simply be restarted.[^15] A voice allocator should reject inaudible/low-priority events before expensive spatial processing and release all nodes on end, cancellation and world destruction.

### Verified sound candidates

These are audition candidates, not approval of their artistic fit or a claim that a complete soundtrack already exists.

| Source | Verified license/content | Appropriate next use |
| --- | --- | --- |
| Kenney Impact Sounds | Provider lists 130 files, CC0, 2019 release.[^16] | Small curated impact/material vocabulary, then layer and edit for this world. |
| Kenney RPG Audio | Provider lists 50 files, CC0, 2014 release; categories include foley, footsteps and weapons.[^17] | Tool, inventory and preparation starting set. Not automatically a polished sword-fight mix. |
| Kenney Music Jingles | Provider lists 85 files, CC0, 2014 release.[^18] | Audition short result/UI motifs. Jingles are not a full ambient/combat score. |
| Magnesus, Walking through forest | Creator's Freesound page lists CC0, mono FLAC, 37.661 seconds, recorded path/leaves/mud footsteps.[^19] | Source for individually edited outdoor steps; inspect noise, consistent level and contact timing. Requires account to download. |
| Antoine Goumain/Antoinemax, Nature Sounds Pack | Creator lists ambience, foliage, steps and stream recordings; **CC BY 4.0, not CC0**.[^20] | A compact environmental audition alternative if attribution requirements are accepted. Do not relabel it CC0 because it appears in a broad free-sound collection. |
| Sonniss GameAudioGDC bundle | Current license permits specified commercial project use and modification, not standalone sound-library redistribution; version 2.0 effective 27 August 2026.[^21] | Optional curated professional recordings after provenance/distribution review. Not a blanket CC0 source and not a reason to download hundreds of gigabytes. |

For a distinctive, coherent music bed, prefer a small commissioned/original set with explicit game, livestream, replay and promotional rights over unrelated free tracks. If zero-cost-only is required, audition explicitly licensed individual works and retain a separate music-clearance gap until selection. Do not assume a platform's “free music” label covers game distribution or claim Content-ID immunity from a license alone.

## Broadcast synchronization and reliability

### Existing architecture is worth retaining

A MediaStreamAudioDestinationNode can expose a Web Audio graph as a recordable stream.[^22] Hyperia already goes further by taking actual master-node PCM through its AudioWorklet, so replacing the pipeline is not the first task. Preserve genuine browser-mix capture, bounded queues and generation-safe restart behavior.

The current worklet batches 2,048 frames: at 48 kHz that is **42.67 ms per batch**. Its 64-pending-write cap represents up to **2.73 seconds of audio payload capacity**, not proof of that observed latency. Track the oldest pending timestamp and queue duration as well as count. The worklet correctly loops over actual input-array length rather than assuming every processing block is a fixed size; keep that property, as MDN explicitly warns against hardcoding it.[^23]

The current message contains PCM and peak, but no originating sample counter/audio-clock timestamp. Bridge wall-clock arrival and video pacing therefore deserve direct synchronization measurement. Add sample-index/clock provenance in a later bounded implementation, alongside video presentation timestamps and reset epochs. A paused/recreated AudioContext or restarted encoder must create a clear timing boundary rather than replay accumulated content.

`AudioContext.getOutputTimestamp()` relates audio output time to `performance.now()` for diagnostics.[^24] It is not an automatic measure of RTMP/CDN/player latency, particularly with a silent render sink and separate encode path. Preserve both capture-clock provenance and final decoded evidence.

There is also a concrete documentation error in `rtmp-bridge.ts`: its comment interprets `aresample=async=1000` as a 1,000-sample drift threshold. FFmpeg documents this example as compensation up to **1,000 samples per second**.[^25] Do not treat that filter as a proof of synchronization or adjust it blindly to hide clock defects.

### Required proof

Use a deterministic, non-production calibration event with a simultaneously scheduled visual marker and audio impulse, then verify the **decoded destination stream**, not only the source browser. Retain event ID, source clocks, encoded timestamps, observed flash frame, audio peak, start offset and drift. Follow that with actual melee contact, projectile release/impact, tool contact and round transition clips so the calibration does not substitute for real content.

Proposed initial acceptance targets are project targets, not universal standards: absolute calibrated A/V offset within 50 ms at startup and after recovery; no accumulating drift beyond 50 ms during the qualified continuous run; no clipped samples in the approved mix; and no unexplained non-silent-content outage. Agree thresholds against the real delivery platform before release. A muted scene can legitimately contain silence; require expected content events, not continuous arbitrary noise.

Run cold start, warm reconnect, encoder restart, stalled network drain, CDN/player rejoin and long-running load. Verify that neither pilot tone nor silent fallback can satisfy content-health checks. Record audio dropout/queue-age/underrun counters, sample rate, audible cue counts and final decoder timestamps. Test a real viewer outside the capture process. Monitor HLS/RTMP state independently from authoritative round/betting state; a recovered stream must not show stale outcomes as live.

## Scoped implementation sequence and budgets

All budgets below are **proposed starting envelopes**, not measured current results or certified device limits. Keep the existing environmental draw/worker/upload limits; budget animation and audio inside the complete scene, not against an empty test room.

| Slice | Exact integration area | Deliverable and acceptance |
| --- | --- | --- |
| 1. Close invisible actors | `npcs.json`, `MobEntity.ts`, required-world-asset preflight. | Visible native-rig cow with qualified idle/walk/attack/hit/death; required model/clip closure fails startup before a misleading usable world. See blocker below. |
| 2. Qualify one full kit | VRM factory/retarget and equipment helpers; offline source/export manifests. | Current versus one CC0 candidate at matched camera/lighting. One complete body/armor/weapon/shield set passes rest and motion review before multiplying variants. |
| 3. Motion controller | Avatar emote layer, combat manager, movement-facing inputs, animation metadata. | Eight-direction movement, turns, start/stop, tool and combat phases; no network/root double motion; exact interruption/reset behavior. |
| 4. Contact and cue contract | Authoritative action observations, presentation queue, foot/grip contacts, CombatAudioSystem. | Deduplicated server action IDs; cue timing and successful-outcome separation; no duplicate reward or cosmetic stale-round replay. |
| 5. Soundscape and music | ClientAudio, MusicSystem, world zones and new event/cue manifest. | Correct mute initialization; bounded world/hero cues; subject-aware stream mix; loop/crossfade/listening review. |
| 6. End-to-end broadcast | Worklet source, bridge, capture diagnostics and destination playback verification. | Timestamped source provenance, decoded A/V evidence, recovery and sustained-run receipts. |

Start with two full-rate duel heroes plus one current preparation subject. Target animation/IK CPU p95 at or below 1.5 ms for that set on the agreed reference machine, measured in the complete world. This is a profiling target, not a reason to lower hero quality invisibly. Background LOD must preserve elapsed motion and avoid frozen bind poses; log which tier the broadcast subject actually uses.

For audio, initially budget at most eight HRTF voices, retain the current eight-impact cap, and use a separate total allocator of approximately 24 active world/UI/music voices with a reserved critical-cue lane. Two music sources during crossfade and two ambience beds should normally suffice. Measure before adding expensive reverb or more simultaneous layers.

Decoded stereo float audio at 48 kHz costs 384,000 bytes per second: one five-minute track is 115.2 MB before overhead. Set an explicit decoded-cache budget, for example 64 MiB initially, and choose streamed media or bounded active/next-track loading for long music. MDN distinguishes streamed media elements from buffers better suited to precise short-sample control.[^13] Do not infer low runtime memory from a small MP3 download.

For avatar assets, record visible triangles, skinned vertices, draw submissions, bone count, texture residency and shadow cost for the full kit. An initial comparison envelope of roughly 20–30k visible triangles per hero is reasonable to investigate, not a mandated source reduction. Prefer visual silhouette and deformation improvements over arbitrary polygon inflation. Any LOD/compression change must be compared at actual stream encoding resolution as well as native canvas resolution.

## Separate critical blocker: the invisible training cows

The admitted NPC manifest references `asset://models/cow/cow.vrm`; the preparation area requests three cow spawns. A bounded local-path and asset-repository tree search did not find that cow file or an alternative local cow/cattle model. The observed 404 is not just a stale spelling with an already verified substitute.

`MobEntity.createMesh()` creates an invisible picking proxy, then catches model-load failure. The simulation can therefore retain an interactable mob without its visible animal. Moreover, simply adding a normal animated GLB is insufficient: its GLB branch **awaits `loadIdleAnimation()` before examining embedded clips**. That helper requires compatible external animation files; a valid inline-only animated animal can fail before its own clips are used.

Required next change: qualify an actual quadruped asset and either support its native embedded clips first or supply explicitly compatible external clips. Add tests for inline-only GLB, external-clip GLB, missing clips, rig mismatch and late load after destruction. Add admitted mob/NPC model and clip closure to preflight, not just NPC ID membership and spawn bounds. Runtime readiness must distinguish visible model success from proxy existence.

Quaternius' Ultimate Animated Animal Pack is provider-listed CC0 with 12 animated models in glTF/FBX/Blend formats, but the inspected page did not enumerate an exact cow file.[^26] It is a candidate inventory to verify, **not** proof that a suitable cow is already available locally. Do not replace the animal with a humanoid, rename an unrelated model to `.vrm`, or hide the console error as a fix.

## Verification and completion criteria

Keep three separate verdicts: **structural correctness**, **visible/audible quality**, and **sustained delivery performance**. None can replace the other.

- Structural tests load real source/exported rigs and clips: finite normalized transforms, binding/fingerprint compatibility, scene-root ownership, marker ordering, deterministic action deduplication, cancellation and all async generations. Compare two independent avatars to detect accidental shared pose/material state.
- Numerical motion tests retain foot drift during planted intervals, maximum ground penetration, attachment contact displacement, edge direction and transition discontinuity. Proposed hero contact target: planted-foot drift below approximately 1 cm over the marked interval on a static floor, with explicit terrain/slope exceptions reviewed rather than hidden.
- Visual tests show front/rear/side and gameplay angles, every gear slot and weapon family, diagonal travel, tight turns, retreat/cast, equip while moving, tool contacts, death and full restoration. Real ground, authored floors, daylight and night are required. Do not hide feet or hands with camera choices to obtain a pass.
- Audio tests use real decoding and OfflineAudioContext where suitable for gain/routing/envelope checks, followed by actual browser playback/capture on target environments. Verify zero prefs, missing/failed audio, repeated identical server packets, suspend/resume, hot camera switches and stop/destroy behavior.
- Performance tests retain p50/p95/p99 frame times, CPU animation/audio dispatch cost, resident audio/texture memory, active voices, captured PCM queue age and live subject LOD. Compare paired complete-world runs. No benchmark in this document establishes those values.
- Final experience review watches and listens to repeated preparation → loadout → betting close → fight → result → recovery cycles, including short/long fights and outages. Clips must preserve agency, contact, readable outcomes and calm sonic space. The final stream must remain comprehensible after encoding.

Launch acceptance remains open until these tests, full-cycle footage and explicit art/audio review agree. A prettier static frame, a passed schema or a nonzero PCM counter does not establish the finished experience.

## Sources

Primary-source references below were checked on 10 September 2026. Undated documentation is identified as such; provider descriptions are not independent asset-quality certification. Source dates are publication/revision dates shown by the publisher, not search-engine crawl dates.

[^1]: Khronos 3D Formats Working Group. [glTF 2.0 Specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html), version 2.0.1, 11 October 2021; skins and animations sections.
[^2]: Three.js contributors. [SkeletonUtils.js, r183](https://github.com/mrdoob/three.js/blob/r183/examples/jsm/utils/SkeletonUtils.js), version-tagged source, undated page. Local runtime patch version is 0.183.2.
[^3]: Quaternius. [Universal Base Characters](https://quaternius.com/packs/universalbasecharacters.html), August 2025. Provider CC0, formats, topology and tier information.
[^4]: Quaternius. [Modular Character Outfits—Fantasy](https://quaternius.com/packs/modularcharacteroutfitsfantasy.html), November 2025; [provider download tiers](https://quaternius.itch.io/modular-character-outfits-fantasy/purchase), current undated listing.
[^5]: Quaternius. [Universal Animation Library](https://quaternius.itch.io/universal-animation-library), original March 2025; displayed v3.0 changelog 16 June 2026. CC0, release fixes, root-motion alternatives and tier information.
[^6]: Adobe. [Mixamo—Common questions](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html), updated 14 September 2021.
[^7]: Adobe. [Mixamo Additional Terms](https://wwwimages2.adobe.com/content/dam/cc/en/legal/servicetou/Mixamo-Addl-Terms-en_US-20210623.pdf), effective 23 June 2021. This report flags the wording; it is not a legal opinion.
[^8]: Three.js contributors. [AnimationAction](https://threejs.org/docs/pages/AnimationAction.html), undated current documentation. Version-specific integration must follow installed r183 code.
[^9]: Daniel Holden. [Code vs Data Driven Displacement](https://www.theorangeduck.com/page/code-vs-data-driven-displacement), 23 September 2021. Original animation-controller analysis and demonstration.
[^10]: Daniel Holden. [Inverse Kinematics and Foot Locking](https://theorangeduck.com/page/inverse-kinematics-foot-locking), 30 July 2026. Original implementation discussion; contact annotation, bounded leg solving and offline cleanup.
[^11]: Three.js contributors. [CCDIKSolver](https://threejs.org/docs/pages/CCDIKSolver.html), undated current documentation.
[^12]: Daniel Holden. [Let's talk about Animation Quality](https://www.theorangeduck.com/page/animation-quality), 2 October 2024. Original comparative analysis, not a universal minimum-rate standard.
[^13]: MDN contributors. [Web Audio API best practices](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices), modified 27 August 2026.
[^14]: MDN contributors. [Web audio spatialization basics](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Web_audio_spatialization_basics), modified 27 August 2026.
[^15]: MDN contributors. [AudioBufferSourceNode: start()](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start), modified 1 January 2026.
[^16]: Kenney. [Impact Sounds](https://kenney.nl/assets/impact-sounds), version 1.0 released 2019; CC0 and 130-file listing.
[^17]: Kenney. [RPG Audio](https://kenney.nl/assets/rpg-audio), version 1.0 released 2014; CC0 and 50-file listing.
[^18]: Kenney. [Music Jingles](https://kenney.nl/assets/music-jingles), version 1.0 released 2014; CC0 and 85-file listing.
[^19]: Magnesus, published through Freesound. [Walking through forest](https://freesound.org/people/Magnesus/sounds/449652/), 29 November 2018; creator upload, file metadata and CC0 declaration.
[^20]: Antoine Goumain / Antoinemax, published through OpenGameArt. [Nature Sounds Pack](https://opengameart.org/content/nature-sounds-pack), 18 August 2021; creator description and CC BY 4.0 declaration.
[^21]: Sonniss. [The License—GameAudioGDC Bundle](https://sonniss.com/gdc-bundle-license/), version 2.0 effective 27 August 2026. Download-date-dependent license and incorporated-project restrictions.
[^22]: MDN contributors. [MediaStreamAudioDestinationNode](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamAudioDestinationNode), modified 7 March 2024.
[^23]: MDN contributors. [AudioWorkletProcessor: process()](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process), modified 30 October 2025.
[^24]: MDN contributors. [AudioContext: getOutputTimestamp()](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp), modified 23 May 2025.
[^25]: FFmpeg project. [FFmpeg Filters Documentation—aresample](https://ffmpeg.org/ffmpeg-filters.html#aresample-1), undated current documentation, section 8.47.1 example.
[^26]: Quaternius. [Ultimate Animated Animal Pack](https://quaternius.com/packs/ultimateanimatedanimals.html), undated inspected page; license/formats/count only, not exact cow availability.
[^27]: Quaternius. [Universal Animation Library 2](https://quaternius.itch.io/universal-animation-library-2), displayed v2.1 changelog 5 July 2026; CC0, motion categories and current download tiers.
