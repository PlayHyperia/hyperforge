/**
 * Character Selection Module
 *
 * Handles character management for players:
 * - Loading character lists for accounts
 * - Creating new characters
 * - Selecting characters for gameplay
 * - Spawning characters into the world
 *
 * This module extracts character selection logic from ServerNetwork
 * to improve maintainability and separation of concerns.
 */

import type {
  ServerSocket,
  SpawnData,
  DatabaseSystemOperations,
} from "../../shared/types";
import {
  EventType,
  DEFAULT_AVATAR_URL,
  uuid,
  getItem,
  TerrainSystem,
  Entity,
  World,
  type EquipmentSyncData,
  type InventorySyncData,
} from "@hyperforge/shared";
import {
  sendFriendsListSync,
  notifyFriendsOfStatusChange,
} from "./handlers/friends";
import { getAgentManager } from "../../eliza";
import { getAgentRuntimeByCharacterId } from "../../eliza/ModelAgentSpawner.js";
import {
  getDefaultElizaOsApiUrl,
  getDefaultPublicWsUrl,
} from "../../shared/public-ws-url.js";

const TRUSTED_DUEL_BOT_ACCOUNT_IDS = new Set(
  (
    process.env.HYPERIA_TRUSTED_DUEL_BOT_ACCOUNT_IDS ||
    "eliza-duel-bots-account"
  )
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
);

function isTrustedDuelBotAccount(
  accountId: string | null | undefined,
): boolean {
  return !!accountId && TRUSTED_DUEL_BOT_ACCOUNT_IDS.has(accountId);
}

/**
 * Create an ElizaOS agent record for a character
 * This allows the character to appear in the dashboard and be managed as an agent
 */
async function _createElizaOSAgent(
  characterId: string,
  accountId: string,
  name: string,
  avatar?: string,
  wallet?: string,
  isAgent?: boolean,
): Promise<void> {
  try {
    const elizaOSApiUrl =
      process.env.ELIZAOS_API_URL || getDefaultElizaOsApiUrl();

    console.log(
      `[CharacterSelection] 🤖 Creating ElizaOS agent for character: ${name} (${characterId})`,
    );

    // Generate ElizaOS character template
    const username = name.toLowerCase().replace(/\s+/g, "_");
    const characterTemplate = {
      id: characterId, // Use same ID as Hyperia character
      name,
      username,
      system: `You are ${name}, ${isAgent ? "an AI agent" : "a character"} in Hyperia, a 3D multiplayer RPG. ${isAgent ? "You can autonomously move around the world, fight enemies, gather resources, manage your inventory, and interact with other players." : "You are controlled by a human player but can also operate autonomously when needed."} You are adventurous, strategic, and always ready for new challenges.`,

      bio: [
        `I am ${name}, ${isAgent ? "an AI agent" : "a character"} in the world of Hyperia.`,
        isAgent
          ? "I autonomously navigate 3D environments, engage in combat, and interact with other players."
          : "I can be controlled by my human player or operate autonomously when needed.",
        "I'm always learning and adapting to new situations in the game.",
        "My goal is to become a skilled adventurer and help others along the way.",
      ],

      topics: [
        "hyperia",
        "gaming",
        "rpg",
        "combat strategies",
        "resource gathering",
        "inventory management",
        "multiplayer cooperation",
      ],

      adjectives: [
        "adventurous",
        "strategic",
        "helpful",
        "determined",
        "resourceful",
        "brave",
      ],

      plugins: [
        "@elizaos/plugin-sql", // Database operations
        "@hyperforge/plugin-hyperia", // Hyperia game integration
      ],

      settings: {
        secrets: {
          HYPERIA_CHARACTER_ID: characterId,
          HYPERIA_SERVER_URL:
            process.env.PUBLIC_WS_URL || getDefaultPublicWsUrl(),
          HYPERIA_ACCOUNT_ID: accountId, // Link to user's account
          wallet,
        },
        avatar,
        characterType: isAgent ? "ai-agent" : "human-player",
        accountId, // Store in settings for dashboard filtering
      },

      style: {
        all: [
          "Be conversational and natural",
          "Show enthusiasm for the game",
          "Be helpful and collaborative",
        ],
        chat: [
          "Be friendly and approachable",
          "Respond to questions directly",
          "Use game-appropriate language",
        ],
        post: [
          "Keep posts concise and engaging",
          "Share tips and discoveries",
          "Celebrate achievements",
        ],
      },
    };

    // Call ElizaOS API to create agent
    const response = await fetch(`${elizaOSApiUrl}/api/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        characterJson: characterTemplate,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[CharacterSelection] ❌ Failed to create ElizaOS agent: ${response.status} ${errorText}`,
      );
      return;
    }

    const result = await response.json();
    console.log(
      `[CharacterSelection] ✅ ElizaOS agent created successfully:`,
      result,
    );
  } catch (error) {
    console.error(
      "[CharacterSelection] ❌ Error creating ElizaOS agent:",
      error instanceof Error ? error.message : String(error),
    );
    // Don't fail character creation if ElizaOS agent creation fails
    // The character is already in Hyperia DB
  }
}

interface CharacterData {
  id: string;
  name: string;
  avatar?: string | null;
  wallet?: string | null;
  isAgent?: boolean;
  level?: number;
  lastLocation?: { x: number; y: number; z: number };
}

/**
 * Load character list for an account
 */
export async function loadCharacterList(
  accountId: string,
  world: World,
): Promise<CharacterData[]> {
  try {
    const databaseSystem = world.getSystem("database") as
      import("../DatabaseSystem").DatabaseSystem | undefined;
    if (!databaseSystem) return [];
    const chars = await databaseSystem.getCharactersAsync(accountId);
    return chars.map((c) => ({
      id: c.id,
      name: c.name,
      avatar: c.avatar || null,
      wallet: c.wallet || null,
      isAgent: c.isAgent || false, // CRITICAL: Include isAgent flag for routing
    }));
  } catch {
    return [];
  }
}

/**
 * Handle character list request from client
 */
export async function handleCharacterListRequest(
  socket: ServerSocket,
  world: World,
): Promise<void> {
  const accountId = socket.accountId;
  if (!accountId) {
    console.warn(
      "[CharacterSelection] characterListRequest received but socket has no accountId",
    );
    socket.send("characterList", { characters: [] });
    return;
  }
  console.log(
    "[CharacterSelection] 📋 Loading characters for accountId:",
    accountId,
  );
  try {
    const characters = await loadCharacterList(accountId, world);
    socket.send("characterList", { characters });
  } catch (err) {
    console.error("[CharacterSelection] Failed to load character list:", err);
    socket.send("characterList", { characters: [] });
  }
}

/**
 * Handle character creation request from client
 */
export async function handleCharacterCreate(
  socket: ServerSocket,
  data: unknown,
  world: World,
  sendToFn: (socketId: string, name: string, data: unknown) => void,
): Promise<void> {
  console.log(
    "[CharacterSelection] 🎭 handleCharacterCreate called with data:",
    data,
  );

  const payload =
    (data as {
      name?: string;
      avatar?: string;
      wallet?: string;
      isAgent?: boolean;
    }) || {};
  const name = (payload.name || "").trim().slice(0, 50) || "Adventurer";
  const avatar = payload.avatar || undefined;
  const wallet = payload.wallet || undefined;
  const isAgent = payload.isAgent || false;

  console.log("[CharacterSelection] Raw data from payload:", {
    name: payload.name,
    avatar: payload.avatar,
    wallet: payload.wallet,
    isAgent: payload.isAgent,
  });
  console.log("[CharacterSelection] Processed values:", {
    name,
    avatar,
    wallet,
    isAgent,
  });

  // Basic validation: alphanumeric plus spaces, 3-50 chars
  const safeName = name.replace(/[^a-zA-Z0-9 ]/g, "").trim();
  const finalName = safeName.length >= 3 ? safeName : "Adventurer";

  console.log("[CharacterSelection] Final validated name:", finalName);

  const id = uuid();
  const accountId = socket.accountId || "";

  console.log("[CharacterSelection] Character creation params:", {
    characterId: id,
    accountId,
    finalName,
    avatar,
    wallet,
    isAgent,
  });

  if (!accountId) {
    console.error(
      "[CharacterSelection] ❌ ERROR: No accountId on socket!",
      socket.id,
    );
    sendToFn(socket.id, "showToast", {
      message: "Authentication error - no account ID",
      type: "error",
    });
    return;
  }

  try {
    const databaseSystem = world.getSystem("database") as
      import("../DatabaseSystem").DatabaseSystem | undefined;
    if (!databaseSystem) {
      console.error("[CharacterSelection] ❌ ERROR: DatabaseSystem not found!");
      sendToFn(socket.id, "showToast", {
        message: "Server error - database not available",
        type: "error",
      });
      return;
    }

    const result = await databaseSystem.createCharacter(
      accountId,
      id,
      finalName,
      avatar,
      wallet,
      isAgent,
    );

    if (!result) {
      console.error(
        "[CharacterSelection] ❌ createCharacter returned false - character may already exist",
      );
      sendToFn(socket.id, "showToast", {
        message: "Character creation failed",
        type: "error",
      });
      return;
    }

    console.log(
      "[CharacterSelection] ✅ Character creation successful, sending response",
    );

    // NOTE: AI agent creation is handled by CharacterEditorScreen
    // User will configure the agent personality before it's created in ElizaOS
    // This ensures proper accountId linkage and user customization
  } catch (err) {
    console.error("[CharacterSelection] ❌ EXCEPTION in createCharacter:", err);
    sendToFn(socket.id, "showToast", {
      message: "Character creation error",
      type: "error",
    });
    return;
  }

  const responseData = {
    id,
    name: finalName,
    wallet: wallet || undefined,
    avatar: avatar || undefined,
  };

  console.log(
    "[CharacterSelection] Sending characterCreated response:",
    responseData,
  );

  try {
    sendToFn(socket.id, "characterCreated", responseData);
  } catch (err) {
    console.error(
      "[CharacterSelection] ❌ ERROR sending characterCreated packet:",
      err,
    );
  }
}

/**
 * Handle character selection from client
 */
export function handleCharacterSelected(
  socket: ServerSocket,
  data: unknown,
  sendToFn: (socketId: string, name: string, data: unknown) => void,
): void {
  const payload = (data as { characterId?: string }) || {};
  const credentialCharacterId = socket.agentCredentialCharacterId;
  if (
    credentialCharacterId &&
    payload.characterId &&
    payload.characterId !== credentialCharacterId
  ) {
    socket.selectedCharacterId = undefined;
    sendToFn(socket.id, "enterWorldRejected", {
      reason: "credential_character_mismatch",
      message: "This agent credential cannot select that character.",
    });
    return;
  }
  // Store selection in socket for subsequent enterWorld
  socket.selectedCharacterId =
    payload.characterId || credentialCharacterId || undefined;
  sendToFn(socket.id, "characterSelected", {
    characterId: socket.selectedCharacterId || null,
  });
}

function clearClientReadyTimeout(socket: ServerSocket): void {
  if (!socket.clientReadyTimeoutId) return;
  clearTimeout(socket.clientReadyTimeoutId);
  socket.clientReadyTimeoutId = undefined;
}

function isSocketStillActive(socket: ServerSocket, world: World): boolean {
  const networkSystem = world.getSystem("network") as
    { sockets?: Map<string, ServerSocket> } | undefined;

  if (!networkSystem?.sockets) return false;
  if (networkSystem.sockets.get(socket.id) !== socket) return false;

  const readyState = (socket.ws as { readyState?: number } | undefined)
    ?.readyState;
  if (typeof readyState === "number" && readyState >= 2) {
    // CLOSING (2) / CLOSED (3)
    return false;
  }

  return true;
}

export function collectInitialSyncEntities(
  world: World,
  x: number,
  z: number,
  selfId: string,
): Entity[] {
  const entityManager = world.getSystem?.("entity-manager") as
    | {
        getEntitiesNearPosition?: (
          x: number,
          z: number,
          radius?: number,
        ) => Entity[];
      }
    | undefined;

  if (entityManager?.getEntitiesNearPosition) {
    const nearbyEntities = entityManager.getEntitiesNearPosition(x, z);
    const uniqueEntities = new Map<string, Entity>();

    for (const entity of nearbyEntities) {
      if (entity.id !== selfId) {
        uniqueEntities.set(entity.id, entity);
      }
    }

    return Array.from(uniqueEntities.values());
  }

  if (!world.entities?.items) {
    return [];
  }

  const allEntities: Entity[] = [];
  for (const [entityId, entity] of world.entities.items.entries()) {
    if (entityId !== selfId) {
      allEntities.push(entity as Entity);
    }
  }
  return allEntities;
}

/**
 * Handle entering world with selected character
 */
export async function handleEnterWorld(
  socket: ServerSocket,
  data: unknown,
  world: World,
  spawn: SpawnData,
  sendFn: (name: string, data: unknown, ignoreSocketId?: string) => void,
  sendToFn: (socketId: string, name: string, data: unknown) => void,
): Promise<void> {
  const payload =
    (data as {
      characterId?: string;
      loadTestBot?: boolean | string;
      duelBot?: boolean | string;
      botName?: string;
    }) || {};
  // Some clients send characterSelected and enterWorld in separate packets.
  // Reuse the socket-level selection when enterWorld payload omits characterId.
  let characterId =
    payload.characterId ||
    socket.selectedCharacterId ||
    socket.characterId ||
    socket.agentCredentialCharacterId ||
    null;
  const credentialCharacterId = socket.agentCredentialCharacterId;
  if (credentialCharacterId && characterId !== credentialCharacterId) {
    sendToFn(socket.id, "enterWorldRejected", {
      reason: "credential_character_mismatch",
      message: "This agent credential cannot enter as that character.",
    });
    return;
  }
  // Only the connection handler may grant the local test bypass. Never trust
  // the packet flag by itself because this path can skip persistent identity.
  const isLoadTestBot = socket.isLoadTestBot === true;
  // SECURITY: Determine agent/duel-bot status from server-side registries
  // instead of trusting the client-supplied `duelBot` flag.
  // Check both embedded AgentManager and ModelAgentSpawner registries.
  // Exception: load-test bots (already bypass auth) may also claim duelBot
  // from the payload to support the DuelBot test harness which isn't
  // registered in AgentManager.
  const agentManager = getAgentManager();
  const isEmbeddedAgent = !!(
    characterId && agentManager?.hasAgent(characterId)
  );
  const isModelAgent = !!(
    characterId && getAgentRuntimeByCharacterId(characterId)
  );
  const agentIsDuelBot = isEmbeddedAgent || isModelAgent;
  const isAuthenticatedAgent =
    credentialCharacterId !== undefined &&
    characterId === credentialCharacterId;
  const loadTestDuelBot =
    isLoadTestBot && (payload.duelBot === true || payload.duelBot === "true");
  const trustedAccountDuelBot =
    isTrustedDuelBotAccount(socket.accountId) &&
    (payload.duelBot === true || payload.duelBot === "true");
  const isDuelBot = agentIsDuelBot || loadTestDuelBot || trustedAccountDuelBot;
  const botName = payload.botName;

  console.log("[PlayerLoading] enterWorld received", {
    socketId: socket.id,
    accountId: socket.accountId,
    characterId,
    hasExistingPlayer: !!socket.player,
    isLoadTestBot,
    isDuelBot,
    trustedAccountDuelBot,
  });

  // Spawn the entity now, preserving legacy spawn shape
  const existingPlayer = socket.player;
  if (existingPlayer) {
    console.log("[PlayerLoading] enterWorld skipped - player already exists");
    return; // Already spawned
  }
  if (!isSocketStillActive(socket, world)) {
    console.warn(
      `[CharacterSelection] Socket ${socket.id} became inactive before enterWorld spawn; aborting`,
    );
    return;
  }
  const accountId = socket.accountId || undefined;
  const isPlaywrightTest = process.env.PLAYWRIGHT_TEST === "true";

  // Non-bot players must enter with a persistent character ID.
  if (!characterId && !isLoadTestBot && !isDuelBot) {
    if (!accountId) {
      console.warn(
        `[CharacterSelection] Rejecting enterWorld without account/character (socket=${socket.id})`,
      );
      sendToFn(socket.id, "enterWorldRejected", {
        reason: "auth_required",
        message: "Authentication required before entering the world.",
      });
      return;
    }

    try {
      const databaseSystem = world.getSystem("database") as
        import("../DatabaseSystem").DatabaseSystem | undefined;
      if (databaseSystem) {
        const existingCharacters =
          await databaseSystem.getCharactersAsync(accountId);
        if (existingCharacters.length > 0) {
          characterId = existingCharacters[0].id;
          console.log(
            `[CharacterSelection] Resolved missing characterId to ${characterId} for account ${accountId}`,
          );
        } else if (isPlaywrightTest) {
          const generatedCharacterId = `e2e_${uuid()}`;
          const fallbackName = `E2E_${accountId.slice(0, 8)}`;
          const created = await databaseSystem.createCharacter(
            accountId,
            generatedCharacterId,
            fallbackName,
          );
          if (!created) {
            const retryCharacters =
              await databaseSystem.getCharactersAsync(accountId);
            characterId = retryCharacters[0]?.id || null;
          } else {
            characterId = generatedCharacterId;
          }
          if (characterId) {
            console.log(
              `[CharacterSelection] PLAYWRIGHT_TEST created fallback character ${characterId} for account ${accountId}`,
            );
          }
        }
      }
    } catch (err) {
      console.error(
        "[CharacterSelection] Failed to resolve missing characterId:",
        err,
      );
    }

    if (!characterId) {
      console.warn(
        `[CharacterSelection] Rejecting enterWorld with no selected character (account=${accountId})`,
      );
      sendToFn(socket.id, "enterWorldRejected", {
        reason: "character_required",
        message: "Please select or create a character before entering.",
      });
      return;
    }
  }

  // Set socket.characterId IMMEDIATELY for synchronous duplicate detection
  // This must happen BEFORE any async operations (DB queries, entity creation)
  if (characterId) {
    socket.characterId = characterId;
  }

  // DUPLICATE PROTECTION: Check if this characterId already has an active entity
  if (characterId) {
    // First check: Look for active socket with this character
    const networkSystem = world.getSystem("network") as
      { sockets: Map<string, ServerSocket> } | undefined;
    let existingActiveSocket: ServerSocket | undefined = undefined;

    if (networkSystem?.sockets) {
      for (const [, sock] of networkSystem.sockets.entries()) {
        // Check if this socket has claimed this characterId (set immediately on enterWorld)
        // This works even before the player entity is created, preventing race conditions
        if (
          sock.characterId === characterId &&
          sock.alive &&
          sock.id !== socket.id
        ) {
          existingActiveSocket = sock;
          break;
        }
      }
    }

    // If we found an active socket with this character, reject immediately
    if (existingActiveSocket) {
      if (isPlaywrightTest) {
        console.warn(
          `[CharacterSelection] PLAYWRIGHT_TEST forcing character handoff for ${characterId}: closing old socket ${existingActiveSocket.id} in favor of ${socket.id}`,
        );
        // Release the character claim immediately to avoid reconnect races.
        existingActiveSocket.characterId = undefined;
        existingActiveSocket.pendingClientReady = false;
        try {
          existingActiveSocket.ws?.close?.(
            4002,
            "Superseded by PLAYWRIGHT_TEST reconnect",
          );
        } catch (closeErr) {
          console.warn(
            "[CharacterSelection] PLAYWRIGHT_TEST failed to close prior socket:",
            closeErr,
          );
        }
      } else {
        console.warn(
          `[CharacterSelection] ⚠️ Character ${characterId} is already connected with alive socket ${existingActiveSocket.id}! Rejecting duplicate spawn from socket ${socket.id}.`,
        );

        // Send rejection packet - client will show a dialog and stay on character select
        // Don't close the socket - let user choose a different character
        sendToFn(socket.id, "enterWorldRejected", {
          reason: "already_logged_in",
          message:
            "Your character is already logged in. Please close the other session first.",
        });

        return; // Reject duplicate connection
      }
    }

    // Second check: Look for stale entities (entity exists but socket is dead)
    let existingEntity: Entity | null = null;
    for (const [, entity] of world.entities.items.entries()) {
      // Check if this entity was spawned with the same characterId
      // (stored as entity ID for persistent characters)
      if (entity.id === characterId) {
        existingEntity = entity;
        break;
      }
    }

    if (existingEntity) {
      // Entity exists but no active socket - this is a stale entity from a crashed connection
      console.log(
        `[CharacterSelection] 🔄 Character ${characterId} has stale entity. Removing stale entity and allowing reconnection.`,
      );

      // Remove the stale entity
      if (world.entities?.remove) {
        world.entities.remove(existingEntity.id);
        console.log(
          `[CharacterSelection] ✅ Removed stale entity ${existingEntity.id}`,
        );
      }

      // Broadcast entity removal to all clients
      sendFn("entityRemoved", existingEntity.id);
      console.log(
        `[CharacterSelection] 📤 Broadcasted entity removal for ${existingEntity.id}`,
      );
    }
  }

  // Load character data from DB if characterId provided
  let name = isLoadTestBot && botName ? botName : "Adventurer";
  let avatar: string | undefined = undefined;
  let walletAddress: string | undefined = undefined;
  let characterData: {
    id: string;
    name: string;
    avatar?: string | null;
    wallet?: string | null;
  } | null = null;

  // Skip character DB lookup for load test bots (performance optimization)
  if (isLoadTestBot) {
    console.log(`[CharacterSelection] Load test bot spawning: ${name}`);
    // Load test bots use socket.id as entity ID, no character DB lookup needed
  } else if (isDuelBot) {
    // Duel bots don't have pre-created characters in the game DB;
    // they use the characterId from ElizaDuelBot settings directly.
    name = botName || characterId || "Duel Bot";
    console.log(
      `[CharacterSelection] Duel bot spawning: ${name} (id: ${characterId})`,
    );
  } else if (characterId) {
    try {
      const databaseSystem = world.getSystem("database") as
        import("../DatabaseSystem").DatabaseSystem | undefined;
      if (databaseSystem) {
        // First try: Look up characters by accountId (normal flow)
        if (accountId) {
          const characters = await databaseSystem.getCharactersAsync(accountId);
          characterData = characters.find((c) => c.id === characterId) || null;
        }

        if (characterData) {
          name = characterData.name;
          avatar = characterData.avatar || undefined;
          walletAddress = characterData.wallet || undefined;
        } else {
          // Character not found - fail fast instead of auto-creating with wrong data
          console.error(
            `[CharacterSelection] ❌ CRITICAL: Character ${characterId} not found in database. Refusing to spawn with incorrect data.`,
          );
          sendToFn(socket.id, "showToast", {
            message:
              "Character not found. Please select a valid character or create a new one.",
            type: "error",
          });
          // Disconnect socket to force user to return to character selection
          if (socket.ws && socket.ws.close) {
            socket.ws.close(4004, "Character not found");
          }
          return; // Exit early - do not spawn
        }
      }
    } catch (err) {
      console.error(
        "[CharacterSelection] ❌ Failed to load character data:",
        err,
      );
    }
  }

  const roles: string[] = [];

  // Require a characterId to ensure persistence uses stable IDs
  const entityId = characterId || socket.id;
  if (!characterId) {
    console.warn(
      `[CharacterSelection] No characterId provided to enterWorld; using ephemeral socketId for bot spawn`,
    );
  }

  // Projectile costs must be reconciled before any player state is read or
  // published. A fired receipt needs an explicit resolution policy, so fail
  // closed before terrain work, entity creation, timers, spatial registration,
  // or PLAYER_JOINED can expose a partially hydrated player.
  const dbSys = world.getSystem?.("database") as
    DatabaseSystemOperations | undefined;
  const custodyPersistenceId = characterId || entityId;
  if (dbSys?.recoverPendingProjectileRuneCostOperationsAsync) {
    await dbSys.recoverPendingProjectileRuneCostOperationsAsync(
      custodyPersistenceId,
    );
  }
  if (dbSys?.recoverPendingAmmunitionShotOperationsAsync) {
    await dbSys.recoverPendingAmmunitionShotOperationsAsync(
      custodyPersistenceId,
    );
  }

  // Load saved position from character data if available
  let position = Array.isArray(spawn.position)
    ? ([...spawn.position] as [number, number, number])
    : [0, 50, 0];
  const quaternion = Array.isArray(spawn.quaternion)
    ? ([...spawn.quaternion] as [number, number, number, number])
    : [0, 0, 0, 1];

  // Load full character data from DB (position, skills, AND combat preferences)
  // Skip for load test bots - they use default values for performance
  let savedSkills: Record<string, { level: number; xp: number }> | undefined;
  let savedAutoRetaliate = true; // Default ON (classic MMORPG behavior)
  if (characterId && accountId && !isLoadTestBot) {
    try {
      const databaseSystem = world.getSystem("database") as
        import("../DatabaseSystem").DatabaseSystem | undefined;
      if (databaseSystem) {
        const savedData = await databaseSystem.getPlayerAsync(characterId);
        if (savedData) {
          // Load position
          if (savedData.positionX !== undefined) {
            const savedY =
              savedData.positionY !== undefined && savedData.positionY !== null
                ? Number(savedData.positionY)
                : 10;
            if (savedY >= 5 && savedY <= 200) {
              position = [
                Number(savedData.positionX) || 0,
                savedY,
                Number(savedData.positionZ) || 0,
              ];
            }
          }
          // Load skills
          savedSkills = {
            attack: { level: savedData.attackLevel, xp: savedData.attackXp },
            strength: {
              level: savedData.strengthLevel,
              xp: savedData.strengthXp,
            },
            defense: {
              level: savedData.defenseLevel,
              xp: savedData.defenseXp,
            },
            constitution: {
              level: savedData.constitutionLevel,
              xp: savedData.constitutionXp,
            },
            ranged: { level: savedData.rangedLevel, xp: savedData.rangedXp },
            magic: {
              level: (savedData as { magicLevel?: number }).magicLevel || 1,
              xp: (savedData as { magicXp?: number }).magicXp || 0,
            },
            woodcutting: {
              level: savedData.woodcuttingLevel || 1,
              xp: savedData.woodcuttingXp || 0,
            },
            mining: {
              level: savedData.miningLevel || 1,
              xp: savedData.miningXp || 0,
            },
            fishing: {
              level: savedData.fishingLevel || 1,
              xp: savedData.fishingXp || 0,
            },
            firemaking: {
              level: savedData.firemakingLevel || 1,
              xp: savedData.firemakingXp || 0,
            },
            cooking: {
              level: savedData.cookingLevel || 1,
              xp: savedData.cookingXp || 0,
            },
            smithing: {
              level: savedData.smithingLevel || 1,
              xp: savedData.smithingXp || 0,
            },
            prayer: {
              level: (savedData as { prayerLevel?: number }).prayerLevel || 1,
              xp: (savedData as { prayerXp?: number }).prayerXp || 0,
            },
            agility: {
              level: (savedData as { agilityLevel?: number }).agilityLevel || 1,
              xp: (savedData as { agilityXp?: number }).agilityXp || 0,
            },
            crafting: {
              level:
                (savedData as { craftingLevel?: number }).craftingLevel || 1,
              xp: (savedData as { craftingXp?: number }).craftingXp || 0,
            },
            fletching: {
              level:
                (savedData as { fletchingLevel?: number }).fletchingLevel || 1,
              xp: (savedData as { fletchingXp?: number }).fletchingXp || 0,
            },
            runecrafting: {
              level:
                (savedData as { runecraftingLevel?: number })
                  .runecraftingLevel || 1,
              xp:
                (savedData as { runecraftingXp?: number }).runecraftingXp || 0,
            },
          };
          // Load auto-retaliate preference (1=ON, 0=OFF, default ON)
          savedAutoRetaliate =
            ((savedData as { autoRetaliate?: number }).autoRetaliate ?? 1) ===
            1;
        }
      }
    } catch {}
  }

  // Check if player logged out inside a combat arena (server restart edge case)
  // If so, teleport them to the duel arena lobby spawn point
  const { isPositionInsideCombatArena, getDuelArenaConfig } =
    await import("@hyperforge/shared");

  // Duel harness bots should always begin from the normal duel arena lobby.
  if (isLoadTestBot && isDuelBot) {
    const lobby = getDuelArenaConfig().lobbySpawnPoint;
    position = [lobby.x, lobby.y, lobby.z];
  }

  if (isPositionInsideCombatArena(position[0], position[2])) {
    const lobbySpawn = getDuelArenaConfig().lobbySpawnPoint;
    console.log(
      `[CharacterSelection] Player ${characterId} was inside combat arena, teleporting to lobby`,
    );
    position = [lobbySpawn.x, lobbySpawn.y, lobbySpawn.z];
  }

  // Ground to terrain (wait briefly for terrain readiness to avoid below-ground spawns)
  const terrain = world.getSystem("terrain") as InstanceType<
    typeof TerrainSystem
  > | null;

  let terrainReadyAtSpawn = false;
  if (terrain) {
    const terrainWithPhysics = terrain as InstanceType<typeof TerrainSystem> & {
      isPhysicsReadyAt?: (x: number, z: number) => boolean;
    };

    const maxAttempts = 60; // 3s max
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const ready = terrain.isReady?.() ?? true;
      const physicsReady = terrainWithPhysics.isPhysicsReadyAt
        ? terrainWithPhysics.isPhysicsReadyAt(position[0], position[2])
        : true;
      if (ready && physicsReady) {
        terrainReadyAtSpawn = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  if (terrain && terrainReadyAtSpawn) {
    const th = terrain.getHeightAt(position[0], position[2]);
    if (Number.isFinite(th)) {
      position = [position[0], th + 1, position[2]]; // Add +1 to prevent clipping into ground
    } else {
      position = [position[0], Math.max(position[1], 10), position[2]];
    }
  } else {
    // Terrain not ready; use a safe fallback to avoid high velocity tunneling.
    position = [position[0], Math.max(position[1], 10), position[2]];
  }
  // Health should equal constitution level (per user requirement)
  const constitutionLevel = savedSkills?.constitution?.level || 10;
  const playerHealth =
    Number.isFinite(constitutionLevel) && constitutionLevel > 0
      ? constitutionLevel
      : 10;

  if (!isSocketStillActive(socket, world)) {
    console.warn(
      `[CharacterSelection] Socket ${socket.id} became inactive during enterWorld load; skipping spawn`,
    );
    return;
  }

  const addedEntity = world.entities.add
    ? world.entities.add({
        id: entityId,
        type: "player",
        position,
        quaternion,
        owner: socket.id,
        userId: accountId || undefined,
        name,
        health: playerHealth, // Use constitution level instead of HEALTH_MAX
        maxHealth: playerHealth, // Also set maxHealth
        avatar: avatar || world.settings.avatar?.url || DEFAULT_AVATAR_URL,
        sessionAvatar: avatar || undefined, // ✅ Also set sessionAvatar for runtime override
        wallet: walletAddress, // ✅ Character's HD wallet address
        roles,
        // CRITICAL: Pass loaded skills so PlayerEntity constructor uses them instead of defaults
        skills: savedSkills,
        // Combat preference: auto-retaliate (loaded from DB, defaults to ON)
        autoRetaliate: savedAutoRetaliate,
        // Player loading state - immune to aggro/combat until client sends clientReady
        isLoading: true,
      })
    : undefined;

  socket.player = (addedEntity as Entity) || undefined;

  // CRITICAL: Set isLoading on entity.data AFTER entity is created
  // The entity constructor may not copy all properties to data
  const spawnedPlayer = socket.player;
  if (spawnedPlayer) {
    socket.player.data.isLoading = true;
    if (isAuthenticatedAgent || isDuelBot) {
      socket.player.data.isAgent = true;
    }
    if (isDuelBot) {
      socket.player.data.isDuelBot = true;
    }
  }

  if (socket.player && socket.pendingClientReady) {
    console.log(
      `[PlayerLoading] Applying buffered clientReady for player ${entityId}`,
    );
    socket.pendingClientReady = false;
    socket.player.data.isLoading = false;
    clearClientReadyTimeout(socket);
    sendFn("entityModified", {
      id: entityId,
      changes: { isLoading: false },
    });
    world.emit(EventType.PLAYER_READY, {
      playerId: entityId,
    });
  }

  // Log player spawn with loading state
  console.log(
    `[PlayerLoading] Player ${entityId} spawned with isLoading=true (data.isLoading: ${socket.player?.data?.isLoading})`,
  );

  // Anti-exploit: Force player active after 30 seconds if clientReady never received
  // Capture entityId to avoid stale socket.player reference if player reconnects
  const spawnedEntityId = entityId;
  if (socket.player?.data?.isLoading) {
    clearClientReadyTimeout(socket);
    const timeoutId = setTimeout(() => {
      if (socket.clientReadyTimeoutId === timeoutId) {
        socket.clientReadyTimeoutId = undefined;
      }
      const entity = world.entities.get(spawnedEntityId);
      if (!entity?.data?.isLoading) {
        return;
      }

      if (!isSocketStillActive(socket, world)) {
        console.warn(
          `[PlayerLoading] TIMEOUT cleanup: removing orphaned loading player ${spawnedEntityId}`,
        );
        world.emit(EventType.PLAYER_LEFT, { playerId: spawnedEntityId });
        world.entities.remove?.(spawnedEntityId);
        sendFn("entityRemoved", spawnedEntityId);
        return;
      }

      console.warn(
        `[PlayerLoading] TIMEOUT: Player ${spawnedEntityId} never sent clientReady after 30s, forcing active`,
      );
      entity.data.isLoading = false;
      // Broadcast the state change to all clients
      sendFn("entityModified", {
        id: spawnedEntityId,
        changes: { isLoading: false },
      });
    }, 30000);
    socket.clientReadyTimeoutId = timeoutId;
  }

  if (socket.player) {
    // Register player with spatial registry for interest-based network filtering
    const entityManager = world.getSystem?.("entity-manager") as {
      registerPlayer?: (playerId: string, x: number, z: number) => void;
    } | null;
    if (entityManager?.registerPlayer) {
      entityManager.registerPlayer(entityId, position[0], position[2]);
    } else {
      console.warn(
        `[CharacterSelection] EntityManager not available for spatial registration of ${entityId}`,
      );
    }

    // CRITICAL: Load equipment and inventory from DB BEFORE emitting PLAYER_JOINED
    // This ensures systems receive the data via event payload (single source of truth)
    // and eliminates the race condition where two systems query the DB independently
    let equipmentRows: EquipmentSyncData[] | undefined;
    try {
      equipmentRows = dbSys?.getPlayerEquipmentAsync
        ? await dbSys.getPlayerEquipmentAsync(custodyPersistenceId)
        : undefined;
    } catch (err) {
      console.error("[CharacterSelection] ❌ Failed to load equipment:", err);
      // Leave equipmentRows undefined to trigger DB fallback in EquipmentSystem
      equipmentRows = undefined;
    }

    let inventoryRows: InventorySyncData[] | undefined;
    try {
      const rawRows = dbSys?.getPlayerInventoryAsync
        ? await dbSys.getPlayerInventoryAsync(custodyPersistenceId)
        : undefined;
      // Transform to InventorySyncData format (slotIndex, itemId, quantity)
      inventoryRows = rawRows?.map((row) => ({
        slotIndex: row.slotIndex ?? 0,
        itemId: String(row.itemId),
        quantity: row.quantity || 1,
      }));
    } catch (err) {
      console.error("[CharacterSelection] ❌ Failed to load inventory:", err);
      // Leave inventoryRows undefined to trigger DB fallback in InventorySystem
      inventoryRows = undefined;
    }

    // Socket may disconnect while async DB hydration runs.
    if (socket.player?.id !== spawnedPlayer.id) {
      console.warn(
        `[CharacterSelection] Socket ${socket.id} detached before PLAYER_JOINED emit for ${spawnedPlayer.id}; aborting enter-world sync`,
      );
      clearClientReadyTimeout(socket);
      if (world.entities.get(spawnedPlayer.id)) {
        world.emit(EventType.PLAYER_LEFT, { playerId: spawnedPlayer.id });
        world.entities.remove?.(spawnedPlayer.id);
        sendFn("entityRemoved", spawnedPlayer.id);
      }
      return;
    }

    // Emit PLAYER_JOINED with equipment and inventory data in payload
    // Systems will use this data instead of querying DB again
    // If data is undefined (load failed), systems fall back to DB query
    world.emit(EventType.PLAYER_JOINED, {
      playerId: spawnedPlayer.data.id as string,
      userId: characterId || undefined,
      player:
        spawnedPlayer as unknown as import("@hyperforge/shared").PlayerLocal,
      equipment: equipmentRows,
      inventory: inventoryRows,
      isLoadTestBot,
      isAgent: isAuthenticatedAgent || isDuelBot,
    });

    try {
      const spawnedPlayerSnapshot = spawnedPlayer.serialize();
      const initialSyncEntities = collectInitialSyncEntities(
        world,
        position[0],
        position[2],
        spawnedPlayer.id,
      );
      const initialSyncEntityIds = new Set(
        initialSyncEntities.map((entity) => entity.id),
      );

      // Send to everyone else
      sendFn("entityAdded", spawnedPlayerSnapshot, socket.id);
      // And also to the originating socket so their client receives their own entity
      sendToFn(socket.id, "entityAdded", spawnedPlayerSnapshot);

      for (const entity of initialSyncEntities) {
        sendToFn(socket.id, "entityAdded", entity.serialize());
      }

      // Send existing players' equipment to the new player
      // Entity serialization has empty equipment; actual state is in EquipmentSystem
      const equipSys = world.getSystem?.("equipment") as
        | {
            getPlayerEquipment?: (
              id: string,
            ) => Record<string, unknown> | undefined;
          }
        | undefined;
      if (equipSys?.getPlayerEquipment && world.entities?.items) {
        for (const [entityId, entity] of world.entities.items.entries()) {
          if (
            entityId !== spawnedPlayer.id &&
            initialSyncEntityIds.has(entityId) &&
            (entity as Entity).type === "player"
          ) {
            const eq = equipSys.getPlayerEquipment(entityId);
            if (eq) {
              sendToFn(socket.id, "equipmentUpdated", {
                playerId: entityId,
                equipment: eq,
              });
            }
          }
        }
      }

      // Immediately reinforce authoritative transform to avoid initial client-side default pose
      sendToFn(socket.id, "entityModified", {
        id: spawnedPlayer.id,
        changes: {
          p: position,
          q: quaternion,
          v: [0, 0, 0],
          e: "idle",
        },
      });
      // Also broadcast authoritative position to all OTHER players
      // so they get correct initial transform for the newly joined player
      sendFn(
        "entityModified",
        {
          id: spawnedPlayer.id,
          changes: {
            p: position,
            q: quaternion,
            v: [0, 0, 0],
            e: "idle",
          },
        },
        socket.id,
      );
      // Send initial skills to client immediately after spawn
      if (savedSkills) {
        sendToFn(socket.id, "skillsUpdated", {
          playerId: spawnedPlayer.id,
          skills: savedSkills,
        });

        // CRITICAL: Also emit server-side event so EquipmentSystem cache gets populated
        // Without this, equipment validation fails because EquipmentSystem.playerSkills is empty
        world.emit(EventType.SKILLS_UPDATED, {
          playerId: spawnedPlayer.id,
          skills: savedSkills,
        });
      }
      // Send inventory snapshot immediately from persistence to avoid races
      try {
        const dbSys = world.getSystem?.("database") as
          DatabaseSystemOperations | undefined;
        const persistenceId = characterId || spawnedPlayer.id;
        const rows = dbSys?.getPlayerInventoryAsync
          ? await dbSys.getPlayerInventoryAsync(persistenceId)
          : [];
        const coinsRow = dbSys?.getPlayerAsync
          ? await dbSys.getPlayerAsync(persistenceId)
          : null;
        const sorted = rows
          .map((r) => ({
            rawSlot:
              Number.isFinite(r.slotIndex) && (r.slotIndex as number) >= 0
                ? (r.slotIndex as number)
                : Number.MAX_SAFE_INTEGER,
            itemId: String(r.itemId),
            quantity: r.quantity || 1,
          }))
          .sort((a, b) => a.rawSlot - b.rawSlot);
        const items = sorted.map((r, index) => {
          const def = getItem(r.itemId);
          return {
            // Use actual DB slot if valid (0-27), fallback to index for invalid/missing slots
            slot: r.rawSlot < 28 ? r.rawSlot : Math.min(index, 27),
            itemId: r.itemId,
            quantity: r.quantity,
            item: def
              ? {
                  id: def.id,
                  name: def.name,
                  type: def.type,
                  stackable: !!def.stackable,
                  weight: def.weight || 0,
                }
              : {
                  id: r.itemId,
                  name: r.itemId,
                  type: "misc",
                  stackable: false,
                  weight: 0,
                },
          };
        });
        sendToFn(socket.id, "inventoryUpdated", {
          playerId: spawnedPlayer.id,
          items,
          coins: coinsRow?.coins ?? 0,
          maxSlots: 28,
        });
      } catch {}

      // Send equipment to client (using already-loaded data)
      // Always send, even if empty, so client UI initializes correctly
      if (equipmentRows) {
        const equipmentData: Record<string, unknown> = {};
        for (const row of equipmentRows) {
          if (row.itemId && row.slotType) {
            const itemDef = getItem(String(row.itemId));
            if (itemDef) {
              equipmentData[row.slotType] = {
                item: itemDef,
                itemId: String(row.itemId),
              };
            }
          }
        }

        sendToFn(socket.id, "equipmentUpdated", {
          playerId: spawnedPlayer.id,
          equipment: equipmentData,
        });

        // Broadcast this player's equipment to all other players
        // so they can see weapons/armor on the newly joined player
        if (Object.keys(equipmentData).length > 0) {
          sendFn(
            "equipmentUpdated",
            {
              playerId: spawnedPlayer.id,
              equipment: equipmentData,
            },
            socket.id,
          );
        }
      }
      // If equipmentRows is undefined (load failed), EquipmentSystem will send after DB fallback

      // Send enterWorldApproved to signal client can proceed to game
      // This is sent AFTER all entity/inventory/equipment data to ensure client has everything
      sendToFn(socket.id, "enterWorldApproved", {
        characterId: characterId || spawnedPlayer.id,
      });

      // Send friends list sync to the connecting player
      const playerId = characterId || spawnedPlayer.id;
      try {
        await sendFriendsListSync(socket, world, playerId);
        // Notify this player's friends that they came online
        await notifyFriendsOfStatusChange(playerId, "online", world);
      } catch (friendErr) {
        console.warn(
          "[CharacterSelection] Failed to sync friends list:",
          friendErr,
        );
        // Non-fatal - continue even if friends sync fails
      }
    } catch (_err) {}
  }
}
