/**
 * Binary Network Packet Protocol
 * @version 2026-02-25 - Force rebuild for packet sync
 *
 * This module defines the binary protocol for client-server communication in Hyperia.
 * It uses msgpackr for efficient binary serialization and maps packet names to numeric IDs
 * to minimize network bandwidth.
 *
 * **Protocol Design**:
 * - All packets are binary ArrayBuffers (no JSON overhead)
 * - Packet format: [packet_id, data] where packet_id is a small integer
 * - Packet IDs map to method names with "on" prefix (e.g., 'snapshot' → 'onSnapshot')
 * - msgpackr provides efficient binary serialization with structured clone support
 *
 * **Packet Types**:
 *
 * **Core Packets**:
 * - `snapshot`: Full world state update from server
 * - `command`: Client command to server (move, attack, interact)
 * - `ping`/`pong`: Heartbeat/keepalive mechanism
 *
 * **Chat Packets**:
 * - `chatAdded`: New chat message
 * - `chatCleared`: Clear chat history
 *
 * **Entity Packets**:
 * - `entityAdded`: New entity spawned in world
 * - `entityModified`: Entity state changed (position, health, etc.)
 * - `entityRemoved`: Entity removed from world
 * - `entityEvent`: Custom entity event (emote, action, etc.)
 *
 * **Player Packets**:
 * - `moveRequest`: Client requests movement
 * - `playerTeleport`: Server forces player teleport
 * - `playerPush`: Server applies force to player
 * - `playerSessionAvatar`: Player changed avatar
 * - `playerState`: Full player state update
 *
 * **Resource/Gathering Packets**:
 * - `resourceSnapshot`: Initial resource node state
 * - `resourceSpawnPoints`: Spawn locations for resources
 * - `resourceSpawned`/`resourceDepleted`/`resourceRespawned`: Resource lifecycle
 * - `resourceGather`: Client attempts to gather
 * - `gatheringComplete`: Server confirms gathering success
 *
 * **Combat Packets**:
 * - `attackMob`: Client attacks a mob
 *
 * **Inventory Packets**:
 * - `pickupItem`: Client picks up ground item
 * - `inventoryUpdated`: Server syncs inventory state
 *
 * **Character Selection Packets** (feature-flagged):
 * - `characterListRequest`: Request list of characters
 * - `characterCreate`: Create new character
 * - `characterList`: Server returns character list
 * - `characterCreated`: Server confirms character creation
 * - `characterSelected`: Client selects a character
 * - `enterWorld`: Client enters world with selected character
 *
 * **Adding New Packets**:
 * 1. Add packet name to the `names` array (order matters!)
 * 2. Packet ID is automatically assigned based on array index
 * 3. Handler method name gets "on" prefix (e.g., 'snapshot' → 'onSnapshot')
 * 4. Implement handler in ServerNetwork or ClientNetwork
 *
 * **Referenced by**: Socket (send/receive), ServerNetwork, ClientNetwork
 */

import { Packr } from "msgpackr";
import type { PacketInfo } from "../../types/network/networking";

/**
 * msgpackr instance for binary serialization
 * structuredClone ensures complex objects are properly handled
 */
const packr = new Packr({ structuredClone: true });

/**
 * Ordered list of all packet names
 * Array index determines packet ID (0, 1, 2, ...) for network transmission
 * Order must remain consistent across client and server builds
 */
// prettier-ignore
const names = [
  'snapshot',
  'command',
  'chatAdded',
  'chatCleared',
  'entityAdded',
  'entityModified',
  'moveRequest',
  'entityEvent',
  'entityRemoved',
  'playerTeleport',
  'playerPush',
  'playerSessionAvatar',
  'settingsModified',
  'spawnModified',
  'kick',
  'ping',
  'pong',
  // New packets for multiplayer movement
  'input',
  'inputAck',
  'correction',
  'playerState',
  'serverStateUpdate',
  'deltaUpdate',
  'compressedUpdate',
  // Resource system packets
  'resourceSnapshot',
  'resourceSpawnPoints',
  'resourceSpawned',
  'resourceDepleted',
  'resourceRespawned',
  'fishingSpotMoved',  // Fishing spot relocated to new position
  'resourceInteract',  // Server-authoritative: client sends resourceId, server calculates path
  'resourceGather',    // Legacy: used after server paths player to cardinal tile
  'gatheringComplete',
  'gatheringStarted',  // Server -> Client: gathering session started
  'gatheringStopped',  // Server -> Client: gathering session stopped
  'gatheringToolShow', // Server -> Client: show the active gathering tool in hand
  'gatheringToolHide', // Server -> Client: hide gathering tool from hand
  // Processing packets (firemaking/cooking)
  'firemakingRequest', // Client -> Server: request to light fire (tinderbox + logs)
  'cookingRequest',    // Client -> Server: request to cook food on fire/range
  'cookingSourceInteract', // Client -> Server: server-authoritative cooking (walk to fire first)
  'cookingComplete',      // Server -> Client: cooking batch finished
  'fireCreated',          // Server -> Client: fire entity created
  'fireExtinguished',     // Server -> Client: fire entity expired/removed
  'fireLightingStarted',  // Server -> Client: fire lighting begun (show model)
  'fireLightingCancelled', // Server -> Client: fire lighting cancelled (remove preloaded model)
  // Smelting/Smithing packets
  'smeltingSourceInteract', // Client -> Server: player clicked furnace to smelt
  'smithingSourceInteract', // Client -> Server: player clicked anvil to smith
  'processingSmelting', // Client -> Server: player selected bar to smelt from UI
  'processingSmithing', // Client -> Server: player selected item to smith from UI
  'smeltingInterfaceOpen', // Server -> Client: show smelting interface with available bars
  'smithingInterfaceOpen', // Server -> Client: show smithing interface with available recipes
  'smeltingClose',         // Server -> Client: close smelting interface (walked away, etc.)
  'smithingClose',         // Server -> Client: close smithing interface (walked away, etc.)
  'smeltingComplete',      // Server -> Client: smelting batch finished
  'smithingComplete',      // Server -> Client: smithing batch finished
  // Crafting packets (leather, jewelry, gem cutting)
  'craftingSourceInteract', // Client -> Server: player clicked crafting source (needle/chisel)
  'processingCrafting',     // Client -> Server: player selected item to craft from UI
  'craftingInterfaceOpen',  // Server -> Client: show crafting interface with available recipes
  'craftingClose',          // Server -> Client: close crafting interface
  'craftingComplete',       // Server -> Client: crafting batch finished
  // Fletching packets (knife + logs, stringing, arrow tipping)
  'fletchingSourceInteract', // Client -> Server: player used knife on logs or item-on-item
  'processingFletching',     // Client -> Server: player selected recipe to fletch from UI
  'fletchingInterfaceOpen',  // Server -> Client: show fletching interface with available recipes
  'fletchingClose',          // Server -> Client: close fletching interface
  'fletchingComplete',       // Server -> Client: fletching batch finished
  // Tanning packets (NPC tanner)
  'processingTanning',      // Client -> Server: player selected hides to tan from UI
  'tanningInterfaceOpen',   // Server -> Client: show tanning interface with available hides
  'tanningClose',           // Server -> Client: close tanning interface
  'tanningComplete',        // Server -> Client: tanning batch finished
  // Runecrafting packets (essence + altar → runes)
  'runecraftingAltarInteract', // Client -> Server: player clicked runecrafting altar
  // Combat packets
  'attackMob',
  'attackPlayer',  // PvP attack
  'followPlayer',  // Follow another player (classic MMORPG-style)
  'changeAttackStyle',
  'setAutoRetaliate',
  'autoRetaliateChanged',
  // Item pickup packets
  'pickupItem',
  // Inventory action packets
  'dropItem',
  'moveItem',
  'useItem',
  'coinPouchWithdraw',
  // Equipment packets
  'equipItem',
  'unequipItem',
  // Inventory sync packets
  'inventoryUpdated',
  'coinsUpdated',
  'playerWeightUpdated',  // Player inventory weight changed (for stamina drain)
  // Equipment sync packets
  'equipmentUpdated',
  // Skills sync packets
  'skillsUpdated',
  // XP drop visual feedback packets (modern MMORPG-style)
  'xpDrop',
  // UI feedback packets
  'showToast',
  // Death screen packets
  'deathScreen',
  'deathScreenClose',
  'requestRespawn',
  // Death state packets
  'playerSetDead',
  'playerRespawned',
  // Loot packets
  'corpseLoot',
  'corpseLootAll',         // Client -> Server: loot all items from gravestone
  'lootResult',            // Server -> Client: loot transaction result (success/failure)
  // Attack style packets
  'attackStyleChanged',
  'attackStyleUpdate',
  // Combat visual feedback packets
  'combatDamageDealt',
  'projectileLaunched',  // Server -> Client: ranged/magic projectile for visual rendering
  'combatFaceTarget',    // Server -> Client: tell player to face combat target (rotation)
  'combatClearFaceTarget', // Server -> Client: tell player to stop facing combat target
  // Player state packets
  'playerUpdated',
  'playerNameChanged',     // Server -> Client: player name change confirmed
  // Action bar packets
  'actionBarSave',         // Client -> Server: save action bar configuration
  'actionBarLoad',         // Client -> Server: load action bar configuration
  'actionBarState',        // Server -> Client: action bar state response
  // Character selection packets (feature-flagged usage)
  'characterListRequest',
  'characterCreate',
  'characterList',
  'characterCreated',
  'characterSelected',
  'enterWorld',
  'enterWorldApproved',  // Server -> Client: character spawn successful, proceed to game
  'enterWorldRejected',  // Server -> Client: character already logged in
  // Agent goal sync packet (for dashboard display)
  'syncGoal',
  // Agent goal override packet (dashboard -> plugin)
  'goalOverride',
  // Agent thought sync packet (for dashboard thought process display)
  'syncAgentThought',
  // Bank packets
  'bankOpen',
  'bankState',
  'bankDeposit',
  'bankDepositAll',
  'bankWithdraw',
  'bankDepositCoins',
  'bankWithdrawCoins',
  'bankClose',
  'bankMove',
  // Bank tab packets
  'bankCreateTab',     // Create new tab with first item
  'bankDeleteTab',     // Delete tab (items move to main tab)
  'bankMoveToTab',     // Move item between tabs
  'bankSelectTab',     // Client selected a different tab
  // Bank placeholder packets (modern MMORPG style: qty=0 in bank_storage)
  'bankWithdrawPlaceholder',      // Withdraw all and leave qty=0 placeholder (modern MMORPG style)
  'bankReleasePlaceholder',       // Release single placeholder (delete qty=0 row)
  'bankReleaseAllPlaceholders',   // Clear all placeholders (delete all qty=0 rows)
  'bankToggleAlwaysPlaceholder',  // Toggle auto-placeholder setting
  // Bank equipment tab packets (modern MMORPG-style equipment view in bank)
  'bankWithdrawToEquipment',      // Withdraw item directly to equipment slot
  'bankDepositEquipment',         // Deposit single equipment slot to bank
  'bankDepositAllEquipment',      // Deposit all worn equipment to bank
  // Store packets
  'storeOpen',
  'storeState',
  'storeBuy',
  'storeSell',
  'storeClose',
  // NPC interaction packets
  'npcInteract',
  // Generic entity interaction (for chests, interactables, etc.)
  'entityInteract',
  // Dialogue packets
  'dialogueStart',
  'dialogueNodeChange',
  'dialogueResponse',
  'dialogueContinue',
  'dialogueEnd',
  'dialogueClose',
  // Tile movement packets (classic fantasy MMORPG-style)
  'entityTileUpdate',    // Server -> Client: entity moved to new tile position
  'tileMovementStart',   // Server -> Client: movement path started
  'tileMovementEnd',     // Server -> Client: arrived at destination
  // System message packets (UI_MESSAGE events -> chat)
  'systemMessage',       // Server -> Client: system/game messages for chat
  // Player loading state packets (Issue #356)
  'clientReady',         // Client -> Server: client finished loading, player now targetable
  // World time sync packets (day/night cycle)
  'worldTimeSync',       // Server -> Client: periodic world time sync for day/night
  // Prayer system packets
  'prayerToggle',        // Client -> Server: toggle a prayer on/off
  'prayerDeactivateAll', // Client -> Server: deactivate all prayers
  'altarPray',           // Client -> Server: pray at altar to recharge
  'prayerStateSync',     // Server -> Client: full prayer state sync
  'prayerToggled',       // Server -> Client: prayer toggle feedback
  'prayerPointsChanged', // Server -> Client: prayer points changed
  // Quest system packets
  'getQuestList',        // Client -> Server: request quest list
  'getQuestDetail',      // Client -> Server: request quest detail
  'questList',           // Server -> Client: quest list response
  'questDetail',         // Server -> Client: quest detail response
  'questStartConfirm',   // Server -> Client: show quest accept screen
  'questAccept',         // Client -> Server: player accepted quest
  'questAbandon',        // Client -> Server: player abandoned quest
  'questTogglePin',      // Client -> Server: toggle quest pinned status
  'questPinned',         // Server -> Client: quest pin status changed
  'questComplete',       // Client -> Server: request to complete quest (when ready_to_complete)
  'questStarted',        // Server -> Client: quest started successfully
  'questProgressed',     // Server -> Client: quest progress updated
  'questCompleted',      // Server -> Client: quest completed, show rewards
  // XP Lamp packets
  'xpLampUse',           // Client -> Server: use XP lamp on skill
  // Home Teleport packets
  'homeTeleport',        // Client -> Server: request home teleport
  'homeTeleportCancel',  // Client -> Server: cancel home teleport cast
  'homeTeleportStart',   // Server -> Client: casting started (show progress)
  'homeTeleportFailed',  // Server -> Client: teleport failed (combat, cooldown, etc.)
  // Player Trading packets
  'tradeRequest',        // Client -> Server: request trade with target player
  'tradeRequestRespond', // Client -> Server: accept/decline incoming trade request
  'tradeIncoming',       // Server -> Client: notify of incoming trade request
  'tradeStarted',        // Server -> Client: trade session activated (both players)
  'tradeAddItem',        // Client -> Server: add item from inventory to trade offer
  'tradeRemoveItem',     // Client -> Server: remove item from trade offer back to inventory
  'tradeSetItemQuantity',// Client -> Server: set quantity for stackable item in trade
  'tradeUpdated',        // Server -> Client: trade state changed (items, acceptance)
  'tradeAccept',         // Client -> Server: accept current trade state
  'tradeCancelAccept',   // Client -> Server: cancel acceptance (offer modified)
  'tradeCancel',         // Client -> Server: cancel/close trade session
  'tradeCompleted',      // Server -> Client: trade successful, items swapped
  'tradeCancelled',      // Server -> Client: trade cancelled (disconnect, decline, etc.)
  'tradeError',          // Server -> Client: trade operation failed with reason
  'tradeConfirmScreen',  // Server -> Client: move to confirmation screen (classic MMORPG two-screen)
  // Duel Arena packets
  'duel:challenge',        // Client -> Server: challenge player to duel
  'duel:challenge:respond',// Client -> Server: accept/decline duel challenge
  'duelChallengeSent',     // Server -> Client: challenge sent confirmation
  'duelChallengeIncoming', // Server -> Client: incoming challenge notification
  'duelSessionStarted',    // Server -> Client: duel session created (open duel interface)
  'duelChallengeDeclined', // Server -> Client: challenge was declined
  'duelError',             // Server -> Client: duel operation failed with reason
  // Duel rules/stakes packets
  'duel:toggle:rule',      // Client -> Server: toggle a duel rule on/off
  'duel:toggle:equipment', // Client -> Server: toggle equipment restriction
  'duel:accept:rules',     // Client -> Server: accept current rules
  'duel:add:stake',        // Client -> Server: add item to stakes
  'duel:remove:stake',     // Client -> Server: remove item from stakes
  'duel:accept:stakes',    // Client -> Server: accept current stakes
  'duel:accept:final',     // Client -> Server: final confirmation
  'duel:cancel',           // Client -> Server: cancel duel session
  'duelStateUpdated',      // Server -> Client: duel state changed (rules, stakes, acceptance)
  'duelMoveToStakes',      // Server -> Client: both accepted rules, move to stakes screen
  'duelMoveToConfirm',     // Server -> Client: both accepted stakes, move to confirm screen
  'duelStartFight',        // Server -> Client: both confirmed, start countdown/fight
  'duelCancelled',         // Server -> Client: duel was cancelled
  'duelRulesUpdated',      // Server -> Client: rule toggle notification
  'duelEquipmentUpdated',  // Server -> Client: equipment restriction toggle notification
  'duelAcceptanceUpdated', // Server -> Client: acceptance state changed
  'duelStateChanged',      // Server -> Client: duel phase changed (RULES -> STAKES -> CONFIRMING)
  'duelStakesUpdated',     // Server -> Client: stakes changed (add/remove stake)
  'duelCountdownStart',    // Server -> Client: both confirmed, start 3-2-1 countdown
  'duelCountdownTick',     // Server -> Client: countdown tick (3, 2, 1, 0)
  'duelFightBegin',        // Server -> Client: countdown finished, fight begins
  'duelFightStart',        // Server -> Client: fight starting with arena ID
  'duelEnded',             // Server -> Client: duel has ended (winner, loser, rewards)
  'duelCompleted',         // Server -> Client: duel completed with results
  'duelOpponentDisconnected', // Server -> Client: opponent disconnected during duel
  'duelOpponentReconnected',  // Server -> Client: opponent reconnected during duel
  'duelOnDeck',              // Server -> Client: agent is on-deck for next duel (prepare)
  'duel:forfeit',          // Client -> Server: forfeit active duel (surrender)
  // Skill/Spell ability packets
  'useSkill',            // Client -> Server: activate a skill ability
  'castSpell',           // Client -> Server: cast a spell (optionally on target)
  'setAutocast',         // Client -> Server: set autocast spell (or null to disable)
  'skillActivated',      // Server -> Client: skill activation acknowledged
  'spellCast',           // Server -> Client: spell cast acknowledged
  'abilityCooldown',     // Server -> Client: ability cooldown update (skill or spell)
  'abilityFailed',       // Server -> Client: ability failed (cooldown, level, resources, etc.)
  // Friend/Social system packets
  'friendRequest',         // Client -> Server: send friend request by player name
  'friendAccept',          // Client -> Server: accept friend request
  'friendDecline',         // Client -> Server: decline friend request
  'friendRemove',          // Client -> Server: remove friend from list
  'friendsListSync',       // Server -> Client: full friends/requests/ignore list sync
  'friendStatusUpdate',    // Server -> Client: friend came online/offline/location change
  'friendRequestIncoming', // Server -> Client: new friend request received
  'ignoreAdd',             // Client -> Server: add player to ignore list
  'ignoreRemove',          // Client -> Server: remove player from ignore list
  'privateMessage',        // Client -> Server: send private message to player
  'privateMessageReceived',// Server -> Client: incoming private message
  'privateMessageFailed',  // Server -> Client: message delivery failed (offline, ignored, etc.)
  'socialError',           // Server -> Client: social operation error
  // Test/Debug packets (dev only - UI visual testing, no state changes)
  'testLevelUp',           // Server -> Client: test level up popup (visual only)
  'testXpDrop',            // Server -> Client: test XP drop animation (visual only)
  'testDeathScreen',       // Server -> Client: test death screen (visual only)
  // Building collision debug packets
  'debugBuildingCollision',       // Client -> Server: query building collision status
  'debugBuildingCollisionResult', // Server -> Client: building collision status response
  'debugWalkability',             // Client -> Server: enable/disable walkability debug logging
  'debugWalkabilityResult',       // Server -> Client: walkability debug toggle confirmation
  'debugDoorTiles',               // Client -> Server: query door tiles for a building
  'debugDoorTilesResult',         // Server -> Client: door tiles response
  'debugWallBlocking',            // Client -> Server: check wall blocking between tiles
  'debugWallBlockingResult',      // Server -> Client: wall blocking check result
  // Authentication packets (first-message auth pattern for security)
  'authenticate',          // Client -> Server: send auth credentials after connection (security: avoids token in URL)
  'authResult',            // Server -> Client: authentication result (success/failure)
  // Network quality packets
  'rtt',                   // Server -> Client: server-measured round-trip time (WebSocket ping/pong)
  'reconnected',           // Server -> Client: session reconnected (same entity, new socket)
  // Streaming mode packets
  'streamingState',        // Server -> Client: streaming duel state update (phase, agents, countdown)
  'streamingAnnouncement', // Server -> Client: new duel announced
  'streamingFightStart',   // Server -> Client: fight phase started
  'streamingResolution',   // Server -> Client: duel resolved (winner, loser)
  'streamingLeaderboard',  // Server -> Client: leaderboard update
  // Server-authoritative movement correction packet (keep last to avoid ID churn)
  'positionReconcile',
  // Agent state query packets (appended to avoid shifting existing IDs)
  'requestBankState',   // Client -> Server: request bank state without opening bank UI
  // Combat lifecycle packets (appended to avoid shifting existing IDs)
  'combatEnded',        // Server -> Client: PvE combat ended (target dead or disengaged)
  // Application-level keepalive (prevents Cloudflare/proxy WebSocket idle timeout)
  'keepalive',          // Client -> Server: periodic heartbeat to keep proxy connection alive
  // Batched entity spawn (reduces per-entity bandwidth overhead for tile generation)
  'entitiesBatchAdded', // Server -> Client: batch of newly spawned entities for a tile
  // Dev diagnostics
  'tickHealth',         // Server -> Client: tick system health stats for DevStats panel
  // Authoritative projectile impact (appended to preserve all existing packet IDs)
  'projectileHit',      // Server -> Client: remove projectile at server damage time
  // Appended to preserve every existing positional packet ID.
  'runecraftingComplete', // Server -> Client: runecrafting transaction finished
  // Correlated negative processing acknowledgement (append-only protocol).
  'processingRejected', // Server -> Client: requested processing action was rejected
  // Correlated processing liveness acknowledgement (append-only protocol).
  'processingProgress', // Server -> Client: authority still owns the processing request
  // Player-scoped durable processing receipt lookup (bidirectional, append-only).
  'processingRequestStatus',
  // Player-scoped durable command reconstruction and terminal acknowledgement.
  'processingRequestRecovery',
  // Correlated Prayer acknowledgement (append-only protocol).
  'prayerActionReceipt', // Server -> Client: exact authoritative Prayer receipt
  // Durable ordinary external-agent banking (append-only protocol).
  'externalAgentBankTransfer', // Bidirectional: execute/return exact bank receipt
  'externalAgentBankRecovery', // Bidirectional: recover/ack one durable bank command
  // Spectator-safe activity presentation (append-only protocol).
  'fishingInteractionPresentation', // Server -> Client: exact held/world fishing phase
  'processingInteractionPresentation', // Server -> Client: privacy-safe station/portable work state
  // Exact terminal lifecycle for an accepted projectile launch (append-only).
  'projectileCancelled', // Server -> Client: remove one server-cancelled projectile visual
  // Bounded application-level recovery for rare mid-stream projectile gaps.
  'requestProjectileEventReplay', // Client -> Server: request an exact missing sequence range
  'projectileEventReplay', // Server -> Client: ordered authoritative events for that range
  // Exact authoritative completion for a manual inventory-to-ground transfer.
  'groundItemDropResult', // Server -> Client: committed/rejected drop operation receipt
  // Private-preparation contestant host ownership (bidirectional, append-only).
  'duelPreparationHostLease', // Claim/heartbeat acknowledgement for the authenticated contestant
  'duelPreparationStatus', // Private correlated planning/readiness acknowledgement
  'duelPreparationStrategy', // Bounded authenticated external ElizaOS role decision
];

const byName: Record<string, PacketInfo> = {};
const byId: Record<number, PacketInfo> = {};

let ids = -1;

for (const name of names) {
  const id = ++ids;
  const info: PacketInfo = {
    id,
    name,
    method: `on${capitalize(name)}`, // eg 'connect' -> 'onConnect'
  };
  byName[name] = info;
  byId[id] = info;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Exported packet names array for use by other packages.
 * This is the SINGLE SOURCE OF TRUTH for packet ordering.
 * DO NOT duplicate this list elsewhere - import it instead!
 */
export const PACKET_NAMES: readonly string[] = names;

/**
 * Get packet ID from packet name.
 * Returns null if packet name is not found.
 */
export function getPacketId(name: string): number | null {
  const info = byName[name];
  return info ? info.id : null;
}

/**
 * Get packet name from packet ID.
 * Returns null if packet ID is not found.
 */
export function getPacketName(id: number): string | null {
  const info = byId[id];
  return info ? info.name : null;
}

export function writePacket(name: string, data: unknown): ArrayBuffer {
  const info = byName[name];
  if (!info) throw new Error(`writePacket failed: ${name} (name not found)`);
  const packet = packr.pack([info.id, data]);
  // Convert Buffer/Uint8Array to ArrayBuffer
  if (packet instanceof ArrayBuffer) {
    return packet;
  }
  // If it's a view (Buffer/Uint8Array), create a new ArrayBuffer and copy the data
  const arrayBuffer = new ArrayBuffer(packet.length);
  const view = new Uint8Array(arrayBuffer);
  view.set(packet);
  return arrayBuffer;
}

export function readPacket(
  packet: ArrayBuffer | Uint8Array,
): [string, unknown] | [] {
  try {
    // Convert ArrayBuffer to Uint8Array if needed
    const buffer =
      packet instanceof ArrayBuffer ? new Uint8Array(packet) : packet;
    const [id, data] = packr.unpack(buffer);
    const info = byId[id];
    if (!info) {
      // Log warning but don't crash - return empty array so handler can gracefully ignore
      console.warn(
        `[readPacket] Unknown packet ID ${id} - this may indicate a version mismatch between client and server`,
      );
      return [];
    }
    return [info.method, data];
  } catch (error) {
    // Handle any deserialization errors gracefully
    console.error("[readPacket] Failed to deserialize packet:", error);
    return [];
  }
}
