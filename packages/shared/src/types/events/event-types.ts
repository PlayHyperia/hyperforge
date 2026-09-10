/**
 * Event System Types
 *
 * Type definitions for the event system:
 * - EventType enum (all event names)
 * - Event payload interfaces (specific data for each event)
 * - Event system interfaces (subscriptions, handlers)
 * - Event mapping (type-safe emit/on/off)
 */

// ============================================================================
// EVENT TYPE ENUM
// ============================================================================

export enum EventType {
  // General System
  READY = "ready",
  ERROR = "error",
  TICK = "tick",

  // Player Core
  PLAYER_JOINED = "player:joined",
  PLAYER_LEFT = "player:left",
  PLAYER_LOGOUT = "player:logout",
  PLAYER_RECONNECTED = "player:reconnected",
  PLAYER_AVATAR_READY = "player:avatar_ready",
  PLAYER_INIT = "player:init",
  PLAYER_READY = "player:ready",
  PLAYER_REGISTERED = "player:registered",
  PLAYER_UNREGISTERED = "player:unregistered",
  PLAYER_CLEANUP = "player:cleanup",
  PLAYER_AUTHENTICATED = "player:authenticated",
  PLAYER_UPDATED = "player:updated",
  PLAYER_SPAWNED = "player:spawned",
  PLAYER_SPAWN_REQUEST = "player:spawn_request",
  PLAYER_DATA_LOADED = "player:data_loaded",
  PLAYER_DATA_SAVED = "player:data_saved",
  PLAYER_SESSION_STARTED = "player:session_started",
  PLAYER_SESSION_ENDED = "player:session_ended",
  PLAYER_CREATE = "player:create",
  PLAYER_SPAWN_COMPLETE = "player:spawn_complete",
  PLAYER_ANIMATION = "player:animation",
  PLAYER_SET_EMOTE = "player:set_emote",

  // Entity Management
  ENTITY_CREATED = "entity:created",
  ENTITY_UPDATED = "entity:updated",
  ENTITY_INTERACT = "entity:interact",
  ENTITY_INTERACTED = "entity:interacted",
  ENTITY_MOVE_REQUEST = "entity:move_request",
  ENTITY_PROPERTY_REQUEST = "entity:property_request",
  ENTITY_SPAWNED = "entity:spawned",
  ENTITY_DEATH = "entity:death",
  ENTITY_POSITION_CHANGED = "entity:position_changed",
  ENTITY_UNDERGROUND_DETECTED = "entity:underground_detected",
  ENTITY_POSITION_CORRECTED = "entity:position_corrected",
  ENTITY_COMPONENT_ADDED = "entity:component:added",
  ENTITY_COMPONENT_REMOVED = "entity:component:removed",
  ENTITY_HEALTH_CHANGED = "entity:health_changed",
  ENTITY_DAMAGED = "entity:damaged",
  ENTITY_HEALED = "entity:healed",
  ENTITY_LEVEL_CHANGED = "entity:level_changed",

  // Asset Management
  ASSET_LOADED = "asset:loaded",
  ASSETS_LOADING_PROGRESS = "assets:loading:progress",

  // UI System
  UI_TOGGLE = "ui:toggle",
  UI_OPEN_PANE = "ui:open_pane",
  UI_CLOSE_PANE = "ui:close_pane",
  UI_MENU = "ui:menu",
  UI_AVATAR = "ui:avatar",
  UI_KICK = "ui:kick",
  UI_TOAST = "ui:toast",
  UI_SIDEBAR_CHAT_TOGGLE = "ui:sidebar:chat:toggle",
  UI_ACTIONS_UPDATE = "ui:actions:update",
  UI_UPDATE = "ui",
  UI_COMBAT_TARGET_CHANGED = "ui:combat_target:changed",
  UI_COMBAT_TARGET_HEALTH = "ui:combat_target:health",
  UI_HIDE_ELEMENTS = "ui:hide_elements",
  UI_SHOW_ELEMENTS = "ui:show_elements",

  // Network Communication
  NETWORK_CONNECTED = "network:connected",
  NETWORK_DISCONNECTED = "network:disconnected",
  NETWORK_RECONNECTING = "network:reconnecting",
  NETWORK_RECONNECTED = "network:reconnected",
  NETWORK_RECONNECT_FAILED = "network:reconnect_failed",
  NETWORK_MESSAGE_RECEIVED = "network:message:received",
  NETWORK_ENTITY_UPDATES = "network:entity_updates",

  // Client Communication
  CLIENT_CONNECT = "client:connect",
  CLIENT_DISCONNECT = "client:disconnect",
  CLIENT_ENTITY_SYNC = "client:entity_sync",

  // Input System
  INPUT_KEY_DOWN = "input:key:down",
  INPUT_KEY_UP = "input:key:up",
  INPUT_POINTER_DOWN = "input:pointer:down",
  INPUT_POINTER_UP = "input:pointer:up",
  INPUT_POINTER_MOVE = "input:pointer:move",

  // System Settings
  SETTINGS_CHANGED = "settings:changed",

  // Graphics System
  GRAPHICS_RESIZE = "graphics:resize",

  // Terrain System
  TERRAIN_TILE_GENERATED = "terrain:tile:generated",
  TERRAIN_TILE_REGENERATED = "terrain:tile:regenerated",
  TERRAIN_VALIDATION_COMPLETE = "terrain:validation:complete",
  TERRAIN_PHYSICS_READY = "terrain:physics:ready",

  // Road System
  ROADS_GENERATED = "roads:generated",
  ROADS_MASK_READY = "roads:mask:ready",
  TERRAIN_REFRESH_TILES = "terrain:refresh:tiles",

  // Camera System
  CAMERA_SET_TARGET = "camera:set_target",
  CAMERA_CLICK_WORLD = "camera:click:world",
  CAMERA_SET_MODE = "camera:set:mode",
  CAMERA_RESET = "camera:reset",
  CAMERA_TAP = "camera:tap",
  CAMERA_TARGET_CHANGED = "camera:target:changed",
  CAMERA_FOLLOW_PLAYER = "camera:follow_player",

  // Movement System
  MOVEMENT_STOP = "movement:stop",
  MOVEMENT_TOGGLE_RUN = "movement:toggle:run",
  MOVEMENT_STARTED = "movement:started",
  MOVEMENT_STOPPED = "movement:stopped",
  MOVEMENT_SPEED_CHANGED = "movement:speed:changed",
  MOVEMENT_STAMINA_DEPLETED = "movement:stamina:depleted",
  PLAYER_STAMINA_UPDATE = "player:stamina:update",
  MOVEMENT_COMPLETED = "movement:completed",
  MOVEMENT_CLICK_TO_MOVE = "movement:click_to_move",

  // Player Stats & Progression
  PLAYER_LEVEL_UP = "player:level_up",
  PLAYER_LEVEL_CHANGED = "player:level_changed",
  PLAYER_XP_GAINED = "player:xp_gained",
  PLAYER_SKILLS_UPDATED = "player:skills_updated",

  // Player Health & Status
  PLAYER_HEALTH_UPDATED = "player:health_updated",
  PLAYER_DAMAGE = "player:damage",
  /**
   * @deprecated Use PLAYER_SET_DEAD for client death UI, or ENTITY_DEATH for server-side death processing.
   * BREAKING: Nothing emits this event as of the death pipeline fix. External subscribers must migrate.
   * TODO: Remove in next major version.
   */
  PLAYER_DIED = "player:died",
  PLAYER_RESPAWNED = "player:respawned",
  PLAYER_RESPAWN_REQUEST = "player:respawn_request",
  PLAYER_DESTROY = "player:destroy",

  // Player Equipment & Stats
  PLAYER_EQUIPMENT_CHANGED = "player:equipment_changed",
  PLAYER_EQUIPMENT_UPDATED = "player:equipment_updated",
  PLAYER_STATS_EQUIPMENT_UPDATED = "player:stats:equipment_updated",

  // Player Weight (for stamina calculations)
  PLAYER_WEIGHT_CHANGED = "player:weight_changed",

  // Player Movement & Position
  PLAYER_POSITION_UPDATED = "player:position:updated",
  PLAYER_TELEPORT_REQUEST = "player:teleport_request",
  PLAYER_TELEPORTED = "player:teleported",

  // Home Teleport
  HOME_TELEPORT_REQUEST = "home:teleport:request",
  HOME_TELEPORT_CAST_START = "home:teleport:cast_start",
  HOME_TELEPORT_CAST_CANCEL = "home:teleport:cast_cancel",
  HOME_TELEPORT_COMPLETE = "home:teleport:complete",
  HOME_TELEPORT_FAILED = "home:teleport:failed",

  // Player Combat Style
  ATTACK_STYLE_CHANGED = "attack_style:changed",

  // Combat System
  COMBAT_STARTED = "combat:started",
  COMBAT_ENDED = "combat:ended",
  COMBAT_ATTACK = "combat:attack",
  COMBAT_ATTACK_REQUEST = "combat:attack_request",
  COMBAT_START_ATTACK = "combat:start_attack",
  COMBAT_STOP_ATTACK = "combat:stop_attack",
  COMBAT_ATTACK_STYLE_CHANGE = "combat:attack_style:change",
  COMBAT_ATTACK_FAILED = "combat:attack_failed",
  COMBAT_MELEE_ATTACK = "combat:melee_attack",
  COMBAT_RANGED_ATTACK = "combat:ranged_attack",
  COMBAT_MAGIC_ATTACK = "combat:magic_attack",
  COMBAT_PROJECTILE_LAUNCHED = "combat:projectile_launched",
  COMBAT_PROJECTILE_HIT = "combat:projectile_hit",
  COMBAT_PROJECTILE_CANCELLED = "combat:projectile_cancelled",
  COMBAT_SPELL_CAST = "combat:spell_cast",
  COMBAT_AUTOCAST_SET = "combat:autocast_set",
  PLAYER_SET_AUTOCAST = "player:set_autocast",
  COMBAT_AMMO_CONSUMED = "combat:ammo_consumed",
  COMBAT_RUNE_CONSUMED = "combat:rune_consumed",
  COMBAT_MOB_NPC_ATTACK = "combat:mob_npc_attack",
  COMBAT_DAMAGE_DEALT = "combat:damage_dealt",
  COMBAT_DAMAGE_CALCULATE = "combat:damage_calculate",
  COMBAT_ACCURACY_CALCULATE = "combat:accuracy_calculate",
  COMBAT_XP_CALCULATE = "combat:xp_calculate",
  COMBAT_HEAL = "combat:heal",
  COMBAT_MISS = "combat:miss",
  COMBAT_ACTION = "combat:action",
  COMBAT_KILL = "combat:kill",
  COMBAT_LEVEL_CHANGED = "combat:level:changed",
  COMBAT_FOLLOW_TARGET = "combat:follow_target",
  COMBAT_PLAYER_DISENGAGE = "combat:player_disengage", // Player clicked away, cancel their attacking combat
  PENDING_ATTACK_CANCEL = "combat:pending_attack_cancel", // Player clicked elsewhere, cancel pending attack

  // Server-controlled combat visuals (Client display-only)
  // These events are sent from server to client to control combat visuals
  // Client should NOT independently search for attackers or decide facing
  COMBAT_FACE_TARGET = "combat:face_target", // Server tells client to face a specific entity
  COMBAT_CLEAR_FACE_TARGET = "combat:clear_face_target", // Server tells client to stop facing target
  COMBAT_PLAY_ANIMATION = "combat:play_animation", // Server tells client to play combat animation
  COMBAT_SHOW_HITSPLAT = "combat:show_hitsplat", // Server tells client to display hitsplat

  // Aggro System
  AGGRO_PLAYER_LEFT = "aggro:player_left",
  AGGRO_PLAYER_ENTERED = "aggro:player_entered",
  AGGRO_MOB_NPC_AGGROED = "aggro:mob_npc_aggroed",

  // Inventory Management
  INVENTORY_INITIALIZED = "inventory:initialized",
  INVENTORY_UPDATED = "inventory:updated",
  INVENTORY_REQUEST = "inventory:request",
  INVENTORY_FULL = "inventory:full",
  INVENTORY_ITEM_ADDED = "inventory:item_added",
  INVENTORY_ITEM_REMOVED = "inventory:item_removed",
  INVENTORY_MOVE = "inventory:move",
  INVENTORY_USE = "inventory:use",
  INVENTORY_EXAMINE_ITEM = "inventory:examine_item",
  INVENTORY_CONSUME_ITEM = "inventory:consume_item",
  INVENTORY_CHECK = "inventory:check",
  INVENTORY_CAN_ADD = "inventory:can_add",
  INVENTORY_HAS_EQUIPPED = "inventory:has_equipped",
  INVENTORY_ITEM_RIGHT_CLICK = "inventory:item_right_click",
  INVENTORY_UPDATE_COINS = "inventory:update_coins",
  INVENTORY_REMOVE_COINS = "inventory:remove_coins",
  INVENTORY_COINS_UPDATED = "inventory:coins_updated",
  INVENTORY_REMOVE_ITEM = "inventory:remove_item",
  INVENTORY_ADD_COINS = "inventory:add_coins",
  INVENTORY_DROP_ALL = "inventory:drop_all",

  // Item Lifecycle
  ITEM_SPAWNED = "item:spawned",
  ITEM_SPAWN = "item:spawn",
  ITEM_SPAWN_REQUEST = "item:spawn_request",
  ITEM_SPAWN_LOOT = "item:spawn_loot",
  ITEM_DESPAWN = "item:despawn",
  ITEM_DESPAWNED = "item:despawned",
  ITEM_RESPAWN_SHOPS = "item:respawn_shops",
  ITEM_DROPPED = "item:dropped",
  ITEM_DROP = "item:drop",
  ITEM_DROP_RESULT = "item:drop_result",
  LOOT_DROPPED = "loot:dropped",
  MOB_LOOT_COMMITTED = "mob_loot:committed",
  ITEM_PICKUP = "item:picked_up",
  ITEM_PICKUP_REQUEST = "item:pickup_request",
  ITEM_USED = "item:used",
  ITEM_ACTION_SELECTED = "item:action_selected",
  ITEMS_RETRIEVED = "items:retrieved",

  // Item Actions
  ITEM_USE_ON_FIRE = "item:use_on_fire",
  ITEM_USE_ON_ITEM = "item:use_on_item",
  ITEM_ON_ITEM = "item:on:item",
  ITEM_RIGHT_CLICK = "item:right_click",
  ITEM_ACTION_EXECUTE = "item:action:execute",
  ITEM_EXAMINE = "item:examine",
  ITEM_CONSUME = "item:consume",

  // Equipment System
  EQUIPMENT_EQUIP = "equipment:equip",
  EQUIPMENT_UNEQUIP = "equipment:unequip",
  EQUIPMENT_TRY_EQUIP = "equipment:try_equip",
  EQUIPMENT_FORCE_EQUIP = "equipment:force_equip",
  EQUIPMENT_CONSUME_ARROW = "equipment:consume_arrow",
  EQUIPMENT_EQUIPPED = "equipment:equipped",
  EQUIPMENT_UNEQUIPPED = "equipment:unequipped",
  EQUIPMENT_CAN_EQUIP = "equipment:can_equip",

  // Interaction System
  INTERACTION_REGISTER = "interaction:register",
  INTERACTION_UNREGISTER = "interaction:unregister",

  // NPC System
  NPC_SPAWNED = "npc:spawned",
  NPC_SPAWN_REQUEST = "npc:spawn_request",
  NPC_INTERACTION = "npc:interaction",
  NPC_DIALOGUE = "npc:dialogue",
  NPC_TRAINER_OPEN = "trainer:open_request",
  NPC_QUEST_OPEN = "quest:open_request",

  // Quest System
  QUEST_START_CONFIRM = "quest:start_confirm", // Show quest accept screen
  QUEST_START_ACCEPTED = "quest:start_accepted", // Player accepted quest
  QUEST_START_DECLINED = "quest:start_declined", // Player declined quest
  QUEST_STARTED = "quest:started",
  QUEST_PROGRESSED = "quest:progressed",
  QUEST_COMPLETION_COMMITTED = "quest:completion_committed",
  QUEST_COMPLETED = "quest:completed",
  QUEST_ABANDONED = "quest:abandoned",

  // XP Lamp System
  XP_LAMP_USE_REQUEST = "xp_lamp:use_request",
  XP_LAMP_SKILL_SELECTED = "xp_lamp:skill_selected",
  XP_LAMP_APPLIED = "xp_lamp:applied",

  // Mob NPCs
  MOB_NPC_SPAWNED = "mob_npc:spawned",
  MOB_NPC_SPAWN_REQUEST = "mob_npc:spawn_request",
  MOB_NPC_SPAWN_POINTS_REGISTERED = "mob_npc:spawn_points:registered",
  MOB_NPC_DESPAWN = "mob_npc:despawn",
  MOB_NPC_DESPAWNED = "mob_npc:despawned",
  MOB_NPC_RESPAWN_ALL = "mob_npc:respawn_all",
  MOB_NPC_RESPAWNED = "mob_npc:respawn",
  MOB_NPC_DAMAGED = "mob_npc:damaged",
  MOB_NPC_POSITION_UPDATED = "mob_npc:position_updated",
  MOB_NPC_ATTACKED = "mob_npc:attacked",
  NPC_DIED = "npc:died",
  MOB_NPC_EXAMINE = "mob_npc:examine",
  MOB_NPC_AGGRO = "mob_npc:aggro",
  MOB_NPC_CHASE_STARTED = "mob_npc:chase:started",
  MOB_NPC_CHASE_ENDED = "mob_npc:chase:ended",
  MOB_NPC_MOVE_REQUEST = "mob_npc:move:request",
  MOB_NPC_DESTROY = "mob_npc:destroy",

  // Banking System
  BANK_OPEN = "bank:open",
  BANK_OPEN_REQUEST = "bank:open_request",
  BANK_CLOSE = "bank:close",
  BANK_DEPOSIT = "bank:deposit",
  BANK_DEPOSIT_SUCCESS = "bank:deposit_success",
  BANK_DEPOSIT_FAIL = "bank:deposit_fail",
  BANK_DEPOSIT_ALL = "bank:deposit_all",
  BANK_WITHDRAW = "bank:withdraw",
  BANK_WITHDRAW_SUCCESS = "bank:withdraw_success",
  BANK_WITHDRAW_FAIL = "bank:withdraw_fail",
  BANK_REMOVE = "bank:remove",
  BANK_CREATE = "bank:create",

  // Store System
  STORE_OPEN = "store:open",
  STORE_OPEN_REQUEST = "store:open_request",
  STORE_CLOSE = "store:close",
  STORE_BUY = "store:buy",
  STORE_SELL = "store:sell",
  STORE_REGISTER_NPC = "store:register_npc",
  STORE_TRANSACTION = "store:transaction",
  STORE_PLAYER_COINS = "store:player_coins",

  // Starter Chest System
  STARTER_CHEST_LOOTED = "starter_chest:looted",

  // Dialogue System
  DIALOGUE_START = "dialogue:start",
  DIALOGUE_NODE_CHANGE = "dialogue:node_change",
  DIALOGUE_RESPONSE = "dialogue:response",
  DIALOGUE_CONTINUE = "dialogue:continue", // For terminal nodes - player clicks to continue
  DIALOGUE_END = "dialogue:end",

  // Resource System
  RESOURCE_SPAWNED = "resource:spawned",
  RESOURCE_GATHER = "resource:gather",
  RESOURCE_GATHERED = "resource:gathered",
  RESOURCE_HARVEST = "resource:harvest",
  RESOURCE_HARVEST_REQUEST = "resource:harvest_request",
  RESOURCE_DEPLETED = "resource:depleted",
  RESOURCE_RESPAWNED = "resource:respawned",
  RESOURCE_GATHERING_STARTED = "resource:gathering:started",
  RESOURCE_GATHERING_PROGRESS = "resource:gathering:progress",
  RESOURCE_GATHERING_STOPPED = "resource:gathering:stopped",
  RESOURCE_VALIDATION_REQUEST = "resource:validation:request",
  RESOURCE_VALIDATION_COMPLETE = "resource:validation:complete",
  RESOURCE_PLACEMENT_VALIDATE = "resource:placement:validate",
  RESOURCE_RESPAWN_READY = "resource:respawn:ready",
  RESOURCE_GATHERING_COMPLETED = "resource:gathering:completed",
  RESOURCE_SPAWN_POINTS_REGISTERED = "resource:spawn_points:registered",
  RESOURCE_MESH_CREATED = "resource:mesh:created",
  RESOURCE_ACTION = "resource:action",

  // Gathering Tool Visuals (show tool in hand during gathering, like classic MMORPG fishing)
  GATHERING_TOOL_SHOW = "gathering:tool:show",
  GATHERING_TOOL_HIDE = "gathering:tool:hide",
  FISHING_INTERACTION_PRESENTATION = "fishing:interaction:presentation",
  PROCESSING_INTERACTION_PRESENTATION = "processing:interaction:presentation",

  // Skills & XP System
  SKILLS_XP_GAINED = "skills:xp_gained",
  SKILLS_PROGRESS_COMMITTED = "skills:progress_committed",
  DUEL_COMBAT_PROGRESS_COMMITTED = "duel:combat_progress_committed",
  SKILLS_LEVEL_UP = "skills:level_up",
  SKILLS_UPDATED = "skills:updated",
  SKILLS_ACTION = "skills:action",
  SKILLS_RESET = "skills:reset",
  SKILLS_MILESTONE = "skills:milestone",
  XP_DROP_BROADCAST = "xp:drop_broadcast", // Server-side: emitted after XP processing with full data
  XP_DROP_RECEIVED = "xp:drop_received",
  TOTAL_LEVEL_CHANGED = "total:level:changed",

  // Prayer System
  PRAYER_TOGGLE = "prayer:toggle",
  PRAYER_TOGGLED = "prayer:toggled",
  PRAYER_POINTS_CHANGED = "prayer:points_changed",
  PRAYER_DEACTIVATED = "prayer:deactivated",
  PRAYER_STATE_SYNC = "prayer:state_sync",
  PRAYER_DRAIN_TICK = "prayer:drain_tick",

  // Altar System (prayer recharge)
  ALTAR_PRAY = "altar:pray",

  // Chat System
  CHAT_SEND = "chat:send",
  CHAT_MESSAGE = "chat:message",

  // Corpse System
  CORPSE_SPAWNED = "corpse:spawned",
  CORPSE_CLICK = "corpse:click",
  CORPSE_LOOT_REQUEST = "corpse:loot_request",
  CORPSE_LOOT_ALL_REQUEST = "corpse:loot_all_request",
  CORPSE_CLEANUP = "corpse:cleanup",
  CORPSE_EMPTY = "corpse:empty",

  // Fire System
  FIRE_LIGHTING_STARTED = "fire:lighting:started",
  FIRE_LIGHTING_CANCELLED = "fire:lighting:cancelled",
  FIRE_EXTINGUISHED = "fire:extinguished",
  FIRE_CREATED = "fire:created",

  // Cooking System
  COOKING_COMPLETED = "cooking:completed",

  // Processing System
  PROCESSING_FIREMAKING_REQUEST = "processing:firemaking:request",
  PROCESSING_COOKING_REQUEST = "processing:cooking:request",
  PROCESSING_REQUEST_PROGRESS = "processing:request:progress",
  PROCESSING_REQUEST_REJECTED = "processing:request:rejected",
  PROCESSING_REQUEST_STATUS = "processing:request:status",
  PROCESSING_CANCEL = "processing:cancel",

  // Item Targeting System
  TARGETING_START = "targeting:start",
  TARGETING_SELECT = "targeting:select",
  TARGETING_COMPLETE = "targeting:complete",
  TARGETING_CANCEL = "targeting:cancel",

  // Firemaking Events
  FIREMAKING_REQUEST = "firemaking:request",
  FIREMAKING_START = "firemaking:start",
  FIREMAKING_SUCCESS = "firemaking:success",
  FIREMAKING_FAILURE = "firemaking:failure",
  FIREMAKING_MOVE_REQUEST = "firemaking:move:request", // Player should move to adjacent tile after lighting fire

  // Cooking Events
  COOKING_REQUEST = "cooking:request",
  COOKING_START = "cooking:start",
  COOKING_SUCCESS = "cooking:success",
  COOKING_BURN = "cooking:burn",
  COOKING_COMPLETE = "cooking:complete",
  COOKING_INTERACT = "cooking:interact",

  // Smelting Events (furnace: ore → bars)
  SMELTING_INTERACT = "smelting:interact",
  SMELTING_INTERFACE_OPEN = "smelting:interface:open", // UI: show available bars to smelt
  SMELTING_REQUEST = "smelting:request",
  SMELTING_START = "smelting:start",
  SMELTING_SUCCESS = "smelting:success",
  SMELTING_FAILURE = "smelting:failure",
  SMELTING_COMPLETE = "smelting:complete",
  PROCESSING_SMELTING_REQUEST = "processing:smelting:request",

  // Smithing Events (anvil: bars → items)
  SMITHING_INTERACT = "smithing:interact",
  SMITHING_INTERFACE_OPEN = "smithing:interface:open", // UI: show available items to smith
  SMITHING_REQUEST = "smithing:request",
  SMITHING_START = "smithing:start",
  SMITHING_COMPLETE = "smithing:complete",
  PROCESSING_SMITHING_REQUEST = "processing:smithing:request",

  // Crafting Events (leather, jewelry, gem cutting)
  CRAFTING_INTERACT = "crafting:interact",
  CRAFTING_INTERFACE_OPEN = "crafting:interface:open",
  CRAFTING_START = "crafting:start",
  CRAFTING_COMPLETE = "crafting:complete",
  PROCESSING_CRAFTING_REQUEST = "processing:crafting:request",

  // Fletching Events (knife + logs, stringing, arrow tipping)
  FLETCHING_INTERACT = "fletching:interact",
  FLETCHING_INTERFACE_OPEN = "fletching:interface:open",
  FLETCHING_START = "fletching:start",
  FLETCHING_COMPLETE = "fletching:complete",
  PROCESSING_FLETCHING_REQUEST = "processing:fletching:request",

  // Runecrafting Events (instant altar conversion)
  RUNECRAFTING_INTERACT = "runecrafting:interact",
  RUNECRAFTING_COMPLETE = "runecrafting:complete",

  // Tanning Events (NPC tanner: hides → leather)
  TANNING_INTERACT = "tanning:interact",
  TANNING_INTERFACE_OPEN = "tanning:interface:open",
  TANNING_REQUEST = "tanning:request",
  TANNING_COMPLETE = "tanning:complete",

  // Death System
  DEATH_LOOT_COLLECT = "death:loot:collect",
  DEATH_HEADSTONE_EXPIRED = "death:headstone:expired",
  PLAYER_SET_DEAD = "player:set_dead",
  UI_DEATH_SCREEN = "ui:death_screen",
  UI_DEATH_SCREEN_CLOSE = "ui:death_screen:close",
  DEATH_LOOT_HEADSTONE = "death:loot_headstone",
  ENTITY_CREATE_HEADSTONE = "entity:create_headstone",
  ENTITY_REMOVE = "entity:remove",
  WORLD_CREATE_GROUND_ITEM = "world:create_ground_item",
  // Crash recovery - emitted when server recreates death items on startup
  DEATH_RECOVERED = "death:recovered",
  // Loot result events for shadow state confirmation
  LOOT_RESULT = "loot:result",
  LOOT_TIMEOUT = "loot:timeout",
  // Audit logging for death/loot operations
  AUDIT_LOG = "audit:log",

  // AI Navigation System
  AI_NAVIGATION_REQUEST = "ai:navigation:request",
  AI_AGENT_REGISTER = "ai:agent:register",
  AI_AGENT_UNREGISTER = "ai:agent:unregister",
  AI_NAVIGATION_GRID_READY = "ai:navigation:grid:ready",
  AI_AGENT_UNSTUCK = "ai:agent:unstuck",

  // Biome Visualization
  BIOME_TOGGLE_VISUALIZATION = "biome:toggle_visualization",
  BIOME_SHOW_AREA = "biome:show_area",
  BIOME_HIDE_AREA = "biome:hide_area",

  // Stats System
  STATS_UPDATE = "stats:update",

  // Persistence System
  PERSISTENCE_SAVE = "persistence:save",
  PERSISTENCE_LOAD = "persistence:load",

  // Chunk System
  CHUNK_LOADED = "chunk:loaded",
  CHUNK_UNLOADED = "chunk:unloaded",

  // Physics Test Events
  PHYSICS_TEST_RUN_ALL = "physics:test:run_all",
  PHYSICS_TEST_BALL_RAMP = "physics:test:ball_ramp",
  PHYSICS_TEST_CUBE_DROP = "physics:test:cube_drop",
  PHYSICS_TEST_CHARACTER_COLLISION = "physics:test:character_collision",
  PHYSICS_PRECISION_RUN_ALL = "physics:precision:run_all",
  PHYSICS_PRECISION_PROJECTILE = "physics:precision:projectile",
  PHYSICS_PRECISION_COMPLETED = "physics:precision:completed",
  PHYSICS_VALIDATION_REQUEST = "physics:validation:request",
  PHYSICS_VALIDATION_COMPLETE = "physics:validation:complete",
  PHYSICS_GROUND_CLAMP = "physics:ground_clamp",
  PHYSICS_REGISTER = "physics:register",
  PHYSICS_UNREGISTER = "physics:unregister",

  // General Test Events
  TEST_RUN_ALL = "test:run_all",
  TEST_PLAYER_REMOVE = "test:player:remove",
  TEST_BANK_CREATE = "test:bank:create",
  TEST_BANK_REMOVE = "test:bank:remove",
  TEST_STORE_CREATE = "test:store:create",
  TEST_STORE_REMOVE = "test:store:remove",
  TEST_NPC_CREATE = "test:npc:create",
  TEST_NPC_REMOVE = "test:npc:remove",
  TEST_ITEM_CREATE = "test:item:create",
  TEST_ITEM_REMOVE = "test:item:remove",
  TEST_TREE_CREATE = "test:tree:create",
  TEST_TREE_REMOVE = "test:tree:remove",
  TEST_FISHING_SPOT_CREATE = "test:fishing_spot:create",
  TEST_FISHING_SPOT_REMOVE = "test:fishing_spot:remove",
  TEST_FIRE_EXTINGUISH = "test:fire:extinguish",
  TEST_TEXT_CREATE = "test:text:create",
  TEST_WAYPOINT_CREATE = "test:waypoint:create",
  TEST_WAYPOINT_UPDATE = "test:waypoint:update",
  TEST_WAYPOINT_REMOVE = "test:waypoint:remove",
  TEST_OBSTACLE_CREATE = "test:obstacle:create",
  TEST_OBSTACLE_REMOVE = "test:obstacle:remove",
  TEST_BARRIER_CREATE = "test:barrier:create",
  TEST_BARRIER_REMOVE = "test:barrier:remove",
  TEST_TELEPORT_TARGET_CREATE = "test:teleport_target:create",
  TEST_TELEPORT_TARGET_UPDATE = "test:teleport_target:update",
  TEST_TELEPORT_TARGET_REMOVE = "test:teleport_target:remove",
  TEST_EQUIPMENT_RACK_CREATE = "test:equipment_rack:create",
  TEST_EQUIPMENT_RACK_REMOVE = "test:equipment_rack:remove",
  TEST_EQUIPMENT_SLOT_CREATE = "test:equipment_slot:create",
  TEST_EQUIPMENT_SLOT_REMOVE = "test:equipment_slot:remove",
  TEST_EQUIPMENT_SLOT_UPDATE = "test:equipment_slot:update",
  TEST_RUN_FIREMAKING_TESTS = "test:run_firemaking_tests",
  TEST_RUN_COOKING_TESTS = "test:run_cooking_tests",

  // Test Framework Events
  TEST_STATION_CREATED = "test:station:created",
  TEST_RESULT = "test:result",
  TEST_UI_CREATE = "test:ui:create",
  TEST_ZONE_CREATE = "test:zone:create",
  TEST_UI_UPDATE = "test:ui:update",
  TEST_ZONE_UPDATE = "test:zone:update",
  TEST_PLAYER_CREATE = "test:player:create",
  TEST_PLAYER_MOVE = "test:player:move",
  TEST_CLEAR_UI = "test:clear_ui",
  TEST_ALL_COMPLETED = "test:all_completed",
  TEST_REPORT = "test:report",
  TEST_SPAWN_CUBE = "test:spawn_cube",
  TEST_CLEAR_CUBES = "test:clear_cubes",
  TEST_RUN_SUITE = "test:run_suite",

  // Additional UI Events
  UI_CREATE = "ui:create",
  UI_OPEN_MENU = "ui:open_menu",
  UI_CLOSE_MENU = "ui:close_menu",
  UI_CONTEXT_MENU = "ui:context_menu",
  UI_CLOSE_ALL = "ui:close_all",
  UI_SET_VIEWPORT = "ui:set_viewport",
  UI_DRAG_DROP = "ui:drag_drop",
  UI_BANK_DEPOSIT = "ui:bank_deposit",
  UI_BANK_WITHDRAW = "ui:bank_withdraw",
  UI_HEALTH_UPDATE = "ui:update_health",
  UI_PLAYER_UPDATE = "ui:player_update",
  UI_EQUIPMENT_UPDATE = "ui:equipment_update",
  UI_ATTACK_STYLE_GET = "ui:attack_style:get",
  UI_ATTACK_STYLE_UPDATE = "ui:attack_style:update",
  UI_ATTACK_STYLE_CHANGED = "ui:attack_style:changed",
  UI_AUTO_RETALIATE_GET = "ui:auto_retaliate:get",
  UI_AUTO_RETALIATE_UPDATE = "ui:auto_retaliate:update",
  UI_AUTO_RETALIATE_CHANGED = "ui:auto_retaliate:changed",
  UI_MESSAGE = "ui:message",
  UI_REQUEST = "ui:request",
  UI_CONTEXT_ACTION = "ui:context_action",
  UI_KEYBOARD_TEST = "ui:keyboard_test",
  UI_SCREEN_READER_TEST = "ui:screen_reader_test",
  UI_CONTRAST_TEST = "ui:contrast_test",
  UI_COMPLEX_INTERACTION = "ui:complex_interaction",
  UI_INTERACTION_VALIDATION = "ui:interaction_validation",
  UI_TRIGGER_ERROR = "ui:trigger_error",
  UI_TEST_RECOVERY = "ui:test_recovery",
  UI_RESILIENCE_TEST = "ui:resilience_test",

  // Damage & Healing Events
  PLAYER_DAMAGE_TAKEN = "player:damage:taken",
  PLAYER_HEALING_RECEIVED = "player:healing:received",
  ENTITY_DAMAGE_TAKEN = "entity:damage:taken",
  ENTITY_HEALING_RECEIVED = "entity:healing:received",
  ENTITY_REVIVED = "entity:revived",

  // World Events
  WORLD_LOAD_AREA = "world:load_area",
  WORLD_UNLOAD_AREA = "world:unload_area",
  WORLD_GENERATE = "world:generate",
  WORLD_SPAWN_STRUCTURE = "world:spawn_structure",

  // Animation Events
  ANIMATION_COMPLETE = "animation:complete",
  ANIMATION_PLAY = "animation:play",
  ANIMATION_CANCEL = "animation:cancel",
  AVATAR_LOAD_COMPLETE = "avatar_load_complete",

  // Terrain Events
  TERRAIN_CONFIGURE = "terrain:configure",
  TERRAIN_SPAWN_RESOURCE = "terrain:spawn_resource",
  TERRAIN_TILE_UNLOADED = "terrain:tile:unloaded",
  TERRAIN_GENERATE_INITIAL = "terrain:generate-initial",

  // Character System
  CHARACTER_LIST = "character:list",
  CHARACTER_CREATED = "character:created",
  CHARACTER_SELECTED = "character:selected",

  // General Events
  SERVER_CORRECTION = "serverCorrection",
  ENTITY_MODIFIED = "entityModified",
  ENTITY_INTERACT_REQUEST = "entity:interact_request",
  AGGRO_FORCE_TRIGGER = "aggro:force-trigger",

  // Action Bar System
  ACTION_BAR_SLOT_UPDATE = "actionbar:slot:update",
  ACTION_BAR_SLOT_SWAP = "actionbar:slot:swap",

  // Trading System
  TRADE_REQUEST = "trade:request",
  TRADE_REQUEST_RECEIVED = "trade:request_received",
  TRADE_REQUEST_RESPOND = "trade:request_respond",
  TRADE_STARTED = "trade:started",
  TRADE_UPDATED = "trade:updated",
  TRADE_ITEM_ADDED = "trade:item_added",
  TRADE_ITEM_REMOVED = "trade:item_removed",
  TRADE_ACCEPTED = "trade:accepted",
  TRADE_ACCEPT_CANCELLED = "trade:accept_cancelled",
  TRADE_COMPLETED = "trade:completed",
  TRADE_CANCELLED = "trade:cancelled",
  TRADE_ERROR = "trade:error",
  TRADE_CLOSE = "trade:close",
  TRADE_CONFIRM_SCREEN = "trade:confirm_screen",

  // Duel System — Challenges
  DUEL_CHALLENGE_DECLINED = "duel:challenge:declined",
  DUEL_CHALLENGE_EXPIRED = "duel:challenge:expired",
  DUEL_CHALLENGE_CANCELLED = "duel:challenge:cancelled",

  // Duel System — Session Lifecycle
  DUEL_SESSION_CREATED = "duel:session:created",
  DUEL_STATE_CHANGED = "duel:state:changed",
  DUEL_CANCELLED = "duel:cancelled",
  DUEL_COMPLETED = "duel:completed",

  // Duel System — Rules & Equipment
  DUEL_RULES_UPDATED = "duel:rules:updated",
  DUEL_EQUIPMENT_UPDATED = "duel:equipment:updated",
  DUEL_EQUIPMENT_RESTRICT = "duel:equipment:restrict",

  // Duel System — Stakes
  DUEL_STAKES_UPDATED = "duel:stakes:updated",
  DUEL_STAKES_TRANSFER = "duel:stakes:transfer",
  DUEL_STAKES_SETTLE = "duel:stakes:settle",

  // Duel System — Acceptance & Countdown
  DUEL_ACCEPTANCE_UPDATED = "duel:acceptance:updated",
  DUEL_COUNTDOWN_START = "duel:countdown:start",
  DUEL_COUNTDOWN_TICK = "duel:countdown:tick",
  DUEL_FIGHT_START = "duel:fight:start",
  DUEL_ARENA_RELEASED = "duel:arena:released",

  // Duel System — Connectivity
  DUEL_PLAYER_DISCONNECTED = "duel:player:disconnected",
  DUEL_PLAYER_RECONNECTED = "duel:player:reconnected",
}
