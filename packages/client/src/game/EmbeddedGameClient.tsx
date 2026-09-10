/**
 * Embedded Game Client - Spectator Viewport for AI Agents
 *
 * Renders the Hyperia game in embedded mode for viewing agents play in real-time.
 * Auto-connects with embedded configuration and sets up spectator camera.
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { GameClient } from "../screens/GameClient";
import { LoadingScreen } from "../screens/LoadingScreen";
import type { EmbeddedViewportConfig } from "../types/embeddedConfig";
import { getEmbeddedConfig, getQualityPreset } from "../types/embeddedConfig";
import { cloneEmbeddedConfig } from "../lib/embedded-entry";
import type { World } from "@hyperforge/shared";
import { EventType } from "@hyperforge/shared";
import { logger } from "../lib/logger";
import { getStreamingAccessToken } from "../lib/streamingAccessToken";
import { getApiAuthorizationHeaders } from "../lib/api-client";

/** API base URL derived from WebSocket URL */
function getApiBaseUrl(wsUrl: string): string {
  return wsUrl
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/ws$/, "")
    .replace(/\/ws\?.*$/, "");
}

/**
 * Fetch characterId for an agentId from the server
 * This enables spectating agents that are still connecting
 */
async function fetchCharacterIdForAgent(
  apiBaseUrl: string,
  agentId: string,
): Promise<string | null> {
  try {
    // Primary route: agent mapping endpoint (current API)
    const mappingResponse = await fetch(
      `${apiBaseUrl}/api/agents/mapping/${encodeURIComponent(agentId)}`,
      { headers: getApiAuthorizationHeaders() },
    );

    if (mappingResponse.ok) {
      const mapping = (await mappingResponse.json()) as {
        characterId?: string;
      };
      if (mapping.characterId) {
        return mapping.characterId;
      }
    }

    // Backward compatibility fallback for older servers
    const legacyResponse = await fetch(
      `${apiBaseUrl}/api/agents/${encodeURIComponent(agentId)}/spectator-token`,
    );
    if (!legacyResponse.ok) {
      logger.debug(
        `[EmbeddedGameClient] Agent ${agentId} not found yet (${legacyResponse.status})`,
      );
      return null;
    }
    const legacyData = (await legacyResponse.json()) as {
      characterId?: string;
    };
    return legacyData.characterId || null;
  } catch (err) {
    logger.debug(
      `[EmbeddedGameClient] Error fetching characterId: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Cleanup function type returned by setup functions */
type CleanupFn = () => void;

type PrefsSystem = {
  setDPR?: (value: number) => void;
  setShadows?: (value: "none" | "low" | "med" | "high") => void;
  setPostprocessing?: (value: boolean) => void;
  setBloom?: (value: boolean) => void;
  setColorGrading?: (value: string) => void;
  setDepthBlur?: (value: boolean) => void;
  setWaterReflections?: (value: boolean) => void;
};

function isTargetAvatarReady(world: World, targetEntityId: string): boolean {
  const playerDirect = world.entities?.players?.get(targetEntityId) as
    { avatar?: unknown } | undefined;
  if (playerDirect?.avatar) {
    return true;
  }

  if (world.entities?.players) {
    for (const [, player] of world.entities.players) {
      const candidate = player as {
        id?: string;
        characterId?: string;
        avatar?: unknown;
      };
      if (
        (candidate.id === targetEntityId ||
          candidate.characterId === targetEntityId) &&
        candidate.avatar
      ) {
        return true;
      }
    }
  }

  return false;
}

function findEntityBySpectatorTarget(
  world: World,
  targetEntityId: string,
): unknown | null {
  const directMatch =
    world.entities?.items?.get(targetEntityId) ||
    world.entities?.players?.get(targetEntityId);
  if (directMatch) {
    return directMatch;
  }

  if (world.entities?.items) {
    for (const [id, entity] of world.entities.items) {
      const candidate = entity as {
        id?: string;
        characterId?: string;
        data?: { id?: string; characterId?: string };
      };
      if (
        id === targetEntityId ||
        candidate.id === targetEntityId ||
        candidate.characterId === targetEntityId ||
        candidate.data?.id === targetEntityId ||
        candidate.data?.characterId === targetEntityId
      ) {
        return entity;
      }
    }
  }

  if (world.entities?.players) {
    for (const [id, player] of world.entities.players) {
      const candidate = player as {
        id?: string;
        characterId?: string;
        data?: { id?: string; characterId?: string };
      };
      if (
        id === targetEntityId ||
        candidate.id === targetEntityId ||
        candidate.characterId === targetEntityId ||
        candidate.data?.id === targetEntityId ||
        candidate.data?.characterId === targetEntityId
      ) {
        return player;
      }
    }
  }

  return null;
}

/**
 * Disable all player input controls (spectator mode)
 * This prevents click-to-move, keyboard movement, and all other player input
 */
function disablePlayerControls(world: World) {
  // The input system is named "client-input", not "controls"
  const input = world.getSystem("client-input") as {
    disable?: () => void;
    setEnabled?: (enabled: boolean) => void;
  } | null;

  if (input?.disable) {
    input.disable();
    return true;
  }

  if (input?.setEnabled) {
    input.setEnabled(false);
    return true;
  }

  logger.warn(
    "[EmbeddedGameClient] Could not disable controls - client-input system not found or missing disable method",
  );
  return false;
}

/**
 * Return the server-selected spectator follow target when available.
 * This allows server-side fallback targeting to override stale URL params.
 */
function getServerAssignedSpectatorFollowEntity(
  world: World,
): string | undefined {
  const network = world.getSystem("network") as {
    getSpectatorFollowEntity?: () => string | undefined;
    spectatorFollowEntity?: string;
  } | null;
  const followId =
    network?.getSpectatorFollowEntity?.() ?? network?.spectatorFollowEntity;
  return typeof followId === "string" && followId.length > 0
    ? followId
    : undefined;
}

/**
 * Setup spectator camera to follow agent's character
 *
 * CRITICAL: For camera following to work, we must pass the ACTUAL entity instance
 * (not a copy) as the camera target. The camera reads target.position every frame,
 * and TileInterpolator updates entity.position as a THREE.Vector3. If we pass a copy,
 * the camera won't see position updates.
 *
 * Returns a cleanup function to remove event listeners and clear timers.
 */
function setupSpectatorCamera(
  world: World,
  config: EmbeddedViewportConfig,
  onCameraLocked?: () => void,
): CleanupFn {
  // Track all timers for cleanup
  const timeoutIds: ReturnType<typeof setTimeout>[] = [];
  let checkIntervalId: ReturnType<typeof setInterval> | null = null;
  let isCleanedUp = false;

  // In spectator mode, we don't need to disable player controls because:
  // 1. There's no local player entity to control
  // 2. The client-input system may not be fully initialized
  // 3. Spectators are read-only viewers by design
  if (config.mode === "spectator") {
    logger.log(
      "[EmbeddedGameClient] Spectator mode - player controls not applicable (no local player)",
    );
  }

  const resolveTargetEntityId = (): string | undefined =>
    getServerAssignedSpectatorFollowEntity(world) ||
    config.followEntity ||
    config.characterId;

  if (!resolveTargetEntityId()) {
    logger.log(
      "[EmbeddedGameClient] No initial follow target; waiting for server spectator assignment",
    );
  }

  /**
   * Find the ACTUAL entity instance from world.entities
   * This is critical - we need the live entity object, not a copy,
   * so the camera can track position updates from TileInterpolator
   */
  const findLiveEntity = (entityId: string) => {
    // Resolve by both entity-id and character-id aliases.
    const fromCollections = findEntityBySpectatorTarget(world, entityId);
    if (fromCollections) return fromCollections;

    // Try entity-manager as fallback
    const entityManager = world.getSystem("entity-manager") as {
      getEntity?: (id: string) => unknown;
    } | null;
    if (entityManager?.getEntity) {
      return entityManager.getEntity(entityId);
    }

    return null;
  };

  const getCameraSystem = () =>
    (world.getSystem("client-camera-system") as {
      target?: unknown;
      setTarget?: (target: unknown) => void;
      followEntity?: (entity: unknown) => void;
      getCameraInfo?: () => { target?: unknown };
    } | null) ??
    (world.getSystem("client-camera") as {
      target?: unknown;
      setTarget?: (target: unknown) => void;
      followEntity?: (entity: unknown) => void;
      getCameraInfo?: () => { target?: unknown };
    } | null) ??
    (world.getSystem("camera") as {
      target?: unknown;
      setTarget?: (target: unknown) => void;
      followEntity?: (entity: unknown) => void;
      getCameraInfo?: () => { target?: unknown };
    } | null);

  const getTargetId = (target: unknown): string | undefined => {
    if (!target || typeof target !== "object") return undefined;
    const candidate = target as {
      id?: string;
      characterId?: string;
      data?: { id?: string; characterId?: string };
    };
    return (
      candidate.id ||
      candidate.characterId ||
      candidate.data?.id ||
      candidate.data?.characterId
    );
  };

  const isCameraFollowingTarget = (): boolean => {
    const expectedTargetId = resolveTargetEntityId();
    if (!expectedTargetId) return false;

    const cameraSystem = getCameraSystem();
    if (!cameraSystem) return false;
    const activeTarget =
      cameraSystem.getCameraInfo?.().target ?? cameraSystem.target;
    return getTargetId(activeTarget) === expectedTargetId;
  };

  /**
   * Set camera to follow the target entity
   * CRITICAL: Pass the actual entity instance, not a wrapper object!
   */
  const setCameraTarget = (entity: unknown) => {
    if (!entity || isCleanedUp) return;

    const e = entity as { id?: string; position?: unknown };
    if (!e.position) {
      console.warn(
        `[EmbeddedGameClient] Entity ${e.id} has no position - cannot follow`,
      );
      return;
    }

    // CRITICAL: Pass the FULL ENTITY as target, not just { position: entity.position }
    // The camera system reads target.position every frame, and we need
    // TileInterpolator's position updates to be reflected automatically
    const entityWithPosition = entity as {
      position: { x: number; y: number; z: number };
    };

    const cameraSystem = getCameraSystem();
    if (cameraSystem?.followEntity) {
      cameraSystem.followEntity(entityWithPosition);
    } else if (cameraSystem?.setTarget) {
      cameraSystem.setTarget(entityWithPosition);
    }

    world.emit(EventType.CAMERA_SET_TARGET, {
      target: entityWithPosition,
    });
    onCameraLocked?.();

    // Ensure controls are still disabled (belt and suspenders)
    if (config.mode === "spectator") {
      disablePlayerControls(world);
    }
  };

  // Listen for entity spawns to find agent's character
  const handleEntitySpawned = (data: {
    entityId?: string;
    entityType?: string;
    position?: { x: number; y: number; z: number };
    entityData?: Record<string, unknown>;
  }) => {
    if (!data.entityId || isCleanedUp) return;
    const targetEntityId = resolveTargetEntityId();
    if (!targetEntityId) return;

    // Check if this is the entity we want to follow
    const isTargetById = data.entityId === targetEntityId;

    // Also check characterId in entity data
    const entityCharacterId = data.entityData?.characterId as
      string | undefined;
    const isTargetByCharacterId = entityCharacterId === targetEntityId;

    if (isTargetById || isTargetByCharacterId) {
      // Find the LIVE entity instance
      const liveEntity = findLiveEntity(data.entityId);
      if (liveEntity) {
        setCameraTarget(liveEntity);
      } else {
        console.warn(
          `[EmbeddedGameClient] Entity spawned but not found in world.entities: ${data.entityId}`,
        );
      }
    }
  };

  // Subscribe to entity spawned events
  world.on(EventType.ENTITY_SPAWNED, handleEntitySpawned);

  // Also check existing entities (in case character already spawned)
  const checkExistingEntities = () => {
    if (isCleanedUp) return;
    const targetEntityId = resolveTargetEntityId();
    if (!targetEntityId) return;

    // First, try to find the entity directly by ID
    let targetEntity = findLiveEntity(targetEntityId);

    // If not found by ID, search all entities for matching characterId
    if (!targetEntity && world.entities?.items) {
      for (const [, entity] of world.entities.items) {
        const e = entity as { characterId?: string };
        if (e.characterId === targetEntityId) {
          targetEntity = entity;
          break;
        }
      }
    }

    // Also check players map
    if (!targetEntity && world.entities?.players) {
      for (const [, player] of world.entities.players) {
        const p = player as { id?: string; characterId?: string };
        if (p.id === targetEntityId || p.characterId === targetEntityId) {
          targetEntity = player;
          break;
        }
      }
    }

    if (targetEntity) {
      setCameraTarget(targetEntity);
    }
  };

  // Initial immediate check (target may already exist from snapshot deserialize).
  checkExistingEntities();

  // Follow-up check after systems settle.
  const initialCheckId = setTimeout(checkExistingEntities, 250);
  timeoutIds.push(initialCheckId);

  // Also check periodically in case entity spawns are delayed
  checkIntervalId = setInterval(() => {
    if (isCleanedUp) {
      if (checkIntervalId) clearInterval(checkIntervalId);
      return;
    }

    // Only stop when camera follows the requested target (not any target).
    if (isCameraFollowingTarget()) {
      onCameraLocked?.();
      if (checkIntervalId) clearInterval(checkIntervalId);
      checkIntervalId = null;
      return;
    }

    checkExistingEntities();
  }, 1000);

  // Surface a warning after 20s, but keep waiting until a real target is locked.
  // For spectator mode we prefer waiting over dropping viewers into an untracked camera.
  const stopCheckingId = setTimeout(() => {
    if (isCleanedUp) return;

    // One extra immediate attempt before warning.
    checkExistingEntities();
    if (isCameraFollowingTarget()) {
      onCameraLocked?.();
      if (checkIntervalId) {
        clearInterval(checkIntervalId);
        checkIntervalId = null;
      }
      return;
    }

    logger.warn(
      "[EmbeddedGameClient] Spectator target lock still pending after 20s; continuing to wait for target entity",
    );
  }, 20000);
  timeoutIds.push(stopCheckingId);

  // Return cleanup function
  return () => {
    isCleanedUp = true;

    // Clear all timeouts
    timeoutIds.forEach(clearTimeout);

    // Clear interval
    if (checkIntervalId) {
      clearInterval(checkIntervalId);
      checkIntervalId = null;
    }

    // Remove event listener
    world.off(EventType.ENTITY_SPAWNED, handleEntitySpawned);
  };
}

/**
 * Apply quality presets based on embedded config
 */
function applyQualityPresets(world: World, _config: EmbeddedViewportConfig) {
  const quality = getQualityPreset();
  const prefs = world.getSystem("prefs") as PrefsSystem | null;
  if (!prefs) {
    return;
  }

  const shadowLevel: "none" | "low" | "med" | "high" =
    quality.shadows === "none" ? "none" : quality.shadows;
  const dpr = Math.max(0.5, Math.min(1, quality.renderScale));

  prefs.setDPR?.(dpr);
  prefs.setShadows?.(shadowLevel);
  prefs.setPostprocessing?.(quality.postProcessing);
  prefs.setBloom?.(quality.bloom);
  prefs.setColorGrading?.(quality.colorGrading ? "cinematic" : "none");
  prefs.setDepthBlur?.(quality.postProcessing && quality.colorGrading);
  prefs.setWaterReflections?.(quality.shadows !== "none");
}

/**
 * Embedded Game Client Component
 */
export function EmbeddedGameClient() {
  const [config, setConfig] = useState<EmbeddedViewportConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [worldReady, setWorldReady] = useState(false);
  const [terrainReady, setTerrainReady] = useState(false);
  const [cameraLocked, setCameraLocked] = useState(false);
  const [targetAvatarReady, setTargetAvatarReady] = useState(false);
  const [minimumLoadElapsed, setMinimumLoadElapsed] = useState(true);
  const [terrainStalled, setTerrainStalled] = useState(false);
  const [avatarStalled, setAvatarStalled] = useState(false);

  // Store cleanup function in ref to call on unmount
  const worldRef = useRef<World | null>(null);
  const cleanupRef = useRef<CleanupFn | null>(null);
  const terrainPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const terrainTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const avatarPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const avatarTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTerrainPolling = useCallback(() => {
    if (terrainPollRef.current) {
      clearInterval(terrainPollRef.current);
      terrainPollRef.current = null;
    }
    if (terrainTimeoutRef.current) {
      clearTimeout(terrainTimeoutRef.current);
      terrainTimeoutRef.current = null;
    }
  }, []);

  const clearAvatarPolling = useCallback(() => {
    if (avatarPollRef.current) {
      clearInterval(avatarPollRef.current);
      avatarPollRef.current = null;
    }
    if (avatarTimeoutRef.current) {
      clearTimeout(avatarTimeoutRef.current);
      avatarTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Get embedded configuration
    const embeddedConfig = cloneEmbeddedConfig(getEmbeddedConfig());

    if (!embeddedConfig) {
      setError("No embedded configuration found");
      logger.error("[EmbeddedGameClient] Missing window.__HYPERIA_CONFIG__");
      return;
    }

    const isSpectatorMode = embeddedConfig.mode === "spectator";

    // Check if auth token is already available
    if (embeddedConfig.authToken) {
      setConfig(embeddedConfig);
      return;
    }

    if (isSpectatorMode) {
      logger.log(
        "[EmbeddedGameClient] No auth token provided; starting anonymous spectator session",
      );

      // If we have a direct spectate target, start immediately.
      // `followEntity` is a valid spectator target even when characterId is absent.
      if (embeddedConfig.characterId || embeddedConfig.followEntity) {
        setConfig(embeddedConfig);

        // Still listen for auth updates via postMessage
        const handleSpectatorAuthReady = () => {
          const updatedConfig = cloneEmbeddedConfig(getEmbeddedConfig());
          if (updatedConfig?.authToken) {
            logger.log(
              "[EmbeddedGameClient] Auth token received via postMessage (updating)",
            );
            setConfig(updatedConfig);
          }
        };

        window.addEventListener("hyperia:auth-ready", handleSpectatorAuthReady);
        return () => {
          window.removeEventListener(
            "hyperia:auth-ready",
            handleSpectatorAuthReady,
          );
          if (cleanupRef.current) {
            cleanupRef.current();
            cleanupRef.current = null;
          }
        };
      }

      if (embeddedConfig.agentId) {
        // No characterId but we have agentId - poll for it
        logger.log(
          `[EmbeddedGameClient] No characterId, polling for agent ${embeddedConfig.agentId}...`,
        );

        let cancelled = false;
        const apiBaseUrl = getApiBaseUrl(embeddedConfig.wsUrl);

        const pollForCharacterId = async () => {
          let attempts = 0;
          const maxAttempts = 30; // 30 seconds max
          const pollInterval = 1000; // 1 second

          while (!cancelled && attempts < maxAttempts) {
            const characterId = await fetchCharacterIdForAgent(
              apiBaseUrl,
              embeddedConfig.agentId || "",
            );

            // Re-check after await — component may have unmounted during the fetch
            if (cancelled) return;

            if (characterId) {
              logger.log(
                `[EmbeddedGameClient] Found characterId ${characterId} for agent`,
              );
              const updatedConfig = {
                ...embeddedConfig,
                characterId,
                followEntity: characterId,
              };
              if (window.__HYPERIA_CONFIG__) {
                window.__HYPERIA_CONFIG__.characterId = characterId;
                window.__HYPERIA_CONFIG__.followEntity = characterId;
              }
              setConfig(updatedConfig);
              return;
            }

            attempts++;
            await new Promise((resolve) => setTimeout(resolve, pollInterval));
            // Re-check after the sleep delay too
            if (cancelled) return;
          }

          if (!cancelled) {
            logger.warn(
              "[EmbeddedGameClient] Timeout waiting for agent to connect",
            );
            setError(
              "Waiting for agent to connect to Hyperia... Please ensure the agent is running.",
            );
          }
        };

        pollForCharacterId();

        return () => {
          cancelled = true;
          if (cleanupRef.current) {
            cleanupRef.current();
            cleanupRef.current = null;
          }
        };
      } else {
        // Allow connecting without an explicit follow target. The server can
        // provide a default followEntity from the active streaming duel.
        logger.log(
          "[EmbeddedGameClient] No explicit spectator target provided; waiting for server default follow target",
        );
        setConfig(embeddedConfig);

        const handleSpectatorAuthReady = () => {
          const updatedConfig = cloneEmbeddedConfig(getEmbeddedConfig());
          if (updatedConfig?.authToken) {
            logger.log(
              "[EmbeddedGameClient] Auth token received via postMessage (updating)",
            );
            setConfig(updatedConfig);
          }
        };

        window.addEventListener("hyperia:auth-ready", handleSpectatorAuthReady);
        return () => {
          window.removeEventListener(
            "hyperia:auth-ready",
            handleSpectatorAuthReady,
          );
          if (cleanupRef.current) {
            cleanupRef.current();
            cleanupRef.current = null;
          }
        };
      }
    }

    // Auth token not yet available - wait for postMessage from parent window
    // This is the secure way to pass tokens (instead of URL parameters)
    logger.log("[EmbeddedGameClient] Waiting for auth token via postMessage");

    const handleAuthReady = () => {
      const updatedConfig = cloneEmbeddedConfig(getEmbeddedConfig());
      if (updatedConfig?.authToken) {
        logger.log("[EmbeddedGameClient] Auth token received via postMessage");
        setConfig(updatedConfig);
      } else {
        setError("Authentication failed - no token received");
        logger.error(
          "[EmbeddedGameClient] Auth token still missing after auth-ready event",
        );
      }
    };

    // Listen for auth-ready event (fired when postMessage delivers the token)
    window.addEventListener("hyperia:auth-ready", handleAuthReady);

    // Set a timeout - if no token received within 10 seconds, show error
    const timeoutId = setTimeout(() => {
      const currentConfig = getEmbeddedConfig();
      if (!currentConfig?.authToken) {
        setError("Authentication timeout - please try refreshing the page");
        logger.error(
          "[EmbeddedGameClient] Auth token timeout - no token received within 10s",
        );
      }
    }, 10000);

    // Cleanup on unmount
    return () => {
      window.removeEventListener("hyperia:auth-ready", handleAuthReady);
      clearTimeout(timeoutId);
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!config || config.mode !== "spectator") {
      setMinimumLoadElapsed(true);
      return;
    }

    setMinimumLoadElapsed(false);
    const timer = setTimeout(() => setMinimumLoadElapsed(true), 3000);
    return () => clearTimeout(timer);
  }, [config]);

  // Setup callback to configure spectator mode
  // IMPORTANT: All hooks must be called before any conditional returns
  const handleSetup = useCallback(
    (world: World) => {
      if (!config) return;

      worldRef.current = world;

      // Cleanup previous setup if any
      if (cleanupRef.current) {
        cleanupRef.current();
      }

      setWorldReady(false);
      setTerrainReady(false);
      setCameraLocked(false);
      setTargetAvatarReady(false);
      setTerrainStalled(false);
      setAvatarStalled(false);

      const handleWorldReady = () => {
        setWorldReady(true);
        // Apply embedded quality once systems are initialized.
        applyQualityPresets(world, config);
      };
      world.on(EventType.READY, handleWorldReady);

      clearTerrainPolling();
      terrainPollRef.current = setInterval(() => {
        const terrain = world.getSystem("terrain") as {
          isReady?: () => boolean;
          getHeightAt?: (worldX: number, worldZ: number) => number;
          terrainTiles?: Map<string, unknown>;
        } | null;
        if (!terrain?.isReady?.()) {
          return;
        }

        if (config.mode === "spectator") {
          const targetId =
            getServerAssignedSpectatorFollowEntity(world) ||
            config.followEntity ||
            config.characterId;
          if (!targetId) {
            return;
          }

          const targetEntity = findEntityBySpectatorTarget(world, targetId);
          const targetPosition = (
            targetEntity as
              | {
                  position?: { x: number; y: number; z: number };
                }
              | undefined
          )?.position;
          if (!targetPosition) {
            return;
          }

          const loadedTileCount = terrain.terrainTiles?.size ?? 0;
          if (loadedTileCount < 9) {
            return;
          }

          const duelArenaVisuals = world.getSystem("duel-arena-visuals") as {
            isReady?: () => boolean;
          } | null;
          if (duelArenaVisuals?.isReady && !duelArenaVisuals.isReady()) {
            return;
          }

          const groundY = terrain.getHeightAt?.(
            targetPosition.x,
            targetPosition.z,
          );
          if (
            typeof groundY === "number" &&
            Number.isFinite(groundY) &&
            Math.abs(targetPosition.y - groundY) > 3
          ) {
            return;
          }
        }

        if (terrain.isReady()) {
          // READY can be missed in some reconnect/hot-reload races.
          // Terrain readiness implies core world systems are operational.
          setWorldReady(true);
          setTerrainReady(true);
          setTerrainStalled(false);
          clearTerrainPolling();
        }
      }, 100);

      terrainTimeoutRef.current = setTimeout(() => {
        setTerrainStalled(true);
        logger.warn(
          "[EmbeddedGameClient] Terrain readiness timeout reached; continuing to wait for a real ready signal",
        );
      }, 30000);

      const resolveTargetEntityId = () =>
        getServerAssignedSpectatorFollowEntity(world) ||
        config.followEntity ||
        config.characterId;
      const needsTargetAvatar = config.mode === "spectator";
      const checkAvatarReady = () => {
        const targetEntityId = resolveTargetEntityId();
        if (!targetEntityId) {
          return false;
        }

        if (isTargetAvatarReady(world, targetEntityId)) {
          setTargetAvatarReady(true);
          setAvatarStalled(false);
          clearAvatarPolling();
          return true;
        }

        return false;
      };

      if (!needsTargetAvatar) {
        setTargetAvatarReady(true);
      } else {
        const handleAvatarLoadComplete = (payload: unknown) => {
          const data = payload as { playerId?: string; success?: boolean };
          if (data.success === false) return;
          if (data.playerId === resolveTargetEntityId() || checkAvatarReady()) {
            setTargetAvatarReady(true);
            setAvatarStalled(false);
            clearAvatarPolling();
          }
        };
        world.on(EventType.AVATAR_LOAD_COMPLETE, handleAvatarLoadComplete);

        checkAvatarReady();
        avatarPollRef.current = setInterval(() => {
          checkAvatarReady();
        }, 250);
        avatarTimeoutRef.current = setTimeout(() => {
          setAvatarStalled(true);
          logger.warn(
            "[EmbeddedGameClient] Avatar readiness timeout reached; continuing to wait for the target avatar",
          );
        }, 30000);

        const previousCleanup = cleanupRef.current;
        cleanupRef.current = () => {
          previousCleanup?.();
          world.off(EventType.AVATAR_LOAD_COMPLETE, handleAvatarLoadComplete);
          clearAvatarPolling();
        };
      }

      // Setup spectator camera and store cleanup function
      const cameraCleanup = setupSpectatorCamera(world, config, () => {
        setCameraLocked(true);
      });

      const previousCleanup = cleanupRef.current;
      cleanupRef.current = () => {
        previousCleanup?.();
        cameraCleanup();
        world.off(EventType.READY, handleWorldReady);
        clearTerrainPolling();
        clearAvatarPolling();
      };
    },
    [config, clearAvatarPolling, clearTerrainPolling],
  );

  // Loading state - must be after all hooks
  if (!config) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
          color: "white",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ textAlign: "center" }}>
          {error ? (
            <>
              <h2>Configuration Error</h2>
              <p>{error}</p>
            </>
          ) : (
            <>
              <h2>Loading Hyperia Viewport...</h2>
              <p>Initializing viewport</p>
            </>
          )}
        </div>
      </div>
    );
  }

  // Build WebSocket URL WITHOUT authentication token in URL
  // SECURITY: authToken is NOT included in URL (leaks via logs, browser history, referrer headers)
  // Instead, ClientNetwork sends authentication as first message after connection opens
  // The auth credentials are passed via window.__HYPERIA_CONFIG__ which ClientNetwork reads
  const wsUrl = (() => {
    const url = new URL(config.wsUrl, window.location.href);
    if (config.mode === "spectator") {
      url.searchParams.set("mode", "spectator");
      url.searchParams.set(
        "followEntity",
        config.followEntity || config.characterId || "",
      );
      url.searchParams.set("characterId", config.characterId || "");
      const streamToken = getStreamingAccessToken();
      if (streamToken) {
        url.searchParams.set("streamToken", streamToken);
      }
    }
    return url.toString();
  })();

  const requiresCameraLock = config.mode === "spectator";
  const showLoading =
    !minimumLoadElapsed ||
    !worldReady ||
    !terrainReady ||
    (requiresCameraLock && (!cameraLocked || !targetAvatarReady));
  const loadingHeadline = !worldReady
    ? "Initializing world systems..."
    : !terrainReady
      ? "Generating terrain..."
      : !cameraLocked
        ? "Locking camera to target..."
        : "Loading duel avatars...";
  const loadingDetail = !worldReady
    ? "Bootstrapping embedded viewport"
    : !terrainReady
      ? terrainStalled
        ? "Terrain is taking longer than expected; waiting for a real ready signal"
        : "Waiting for terrain and arena state"
      : !cameraLocked
        ? "Following the requested spectator target"
        : !targetAvatarReady
          ? avatarStalled
            ? "Avatar load is delayed; waiting for the target avatar to resolve"
            : "Waiting for the target avatar to finish loading"
          : "Finalizing spectator presentation";

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: "#000",
      }}
    >
      <GameClient
        wsUrl={wsUrl}
        onSetup={handleSetup}
        hideUI={config.mode === "spectator"}
        streamingMode={config.mode === "spectator"}
      />
      {showLoading && worldRef.current && (
        <div style={{ zIndex: 100, position: "absolute", inset: 0 }}>
          <LoadingScreen world={worldRef.current} message={loadingHeadline} />
        </div>
      )}
      {showLoading && !worldRef.current && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0, 0, 0, 1.0)",
            zIndex: 100,
            color: "#f2d08a",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <h2 style={{ fontSize: "1.6rem", marginBottom: "0.8rem" }}>
              {loadingHeadline}
            </h2>
            <p style={{ opacity: 0.75 }}>{loadingDetail}</p>
          </div>
        </div>
      )}
    </div>
  );
}
