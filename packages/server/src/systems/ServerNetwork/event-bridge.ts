/**
 * Event Bridge Module - World event to network message bridge
 *
 * Listens to world events (resource depletion, inventory changes, etc.)
 * and forwards them to connected clients via network messages.
 *
 * Responsibilities:
 * - Subscribe to world events (EventType.RESOURCE_*, INVENTORY_*, etc.)
 * - Transform event data into network messages
 * - Route messages to appropriate clients (broadcast or targeted)
 * - Handle event-specific logic (player ID routing, data transformation)
 *
 * Usage:
 * ```typescript
 * const eventBridge = new EventBridge(world, broadcast);
 * eventBridge.setupEventListeners(); // Register all listeners
 * ```
 */

import { randomUUID } from "node:crypto";

import type {
  World,
  FletchingInterfaceOpenPayload,
  EventMap,
} from "@hyperforge/shared";
import { EventType, ALL_WORLD_AREAS } from "@hyperforge/shared";
import type { BroadcastManager } from "./broadcast";
import { PacketPriority } from "./BandwidthBudget";
import { BankRepository } from "../../database/repositories/BankRepository";
import type { StoreSystem } from "@hyperforge/shared";
import type pg from "pg";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../database/schema";

export type ProjectileReplayPacketName =
  | "projectileLaunched"
  | "projectileHit"
  | "projectileCancelled"
  | "combatDamageDealt";

export interface ProjectileReplayEvent {
  sequence: number;
  name: ProjectileReplayPacketName;
  data: unknown;
}

export interface ProjectileReplayResponse {
  sourceId: string;
  requestedFromSequence: number;
  requestedToSequence: number;
  complete: boolean;
  events: ProjectileReplayEvent[];
}

const MAX_PROJECTILE_REPLAY_SEQUENCES = 256;
const MAX_PROJECTILE_REPLAY_REQUEST_SEQUENCES = 64;

/**
 * EventBridge - Bridges world events to network messages
 *
 * Provides centralized event subscription and message routing.
 */
export class EventBridge {
  /**
   * Deduplication cache for combat damage events.
   * Prevents duplicate damage splats when the same attack is processed twice
   * (e.g., by both initial attack and auto-attack processing within the same tick).
   *
   * Key format: "attackerId-targetId-tick"
   * Value: { tick, damages } — tick stored directly to avoid string parsing during cleanup
   */
  private recentDamageEvents = new Map<string, number>();
  private lastCleanupTick = 0;
  private readonly projectileNetworkEventSourceId = randomUUID();
  private projectileNetworkEventSequence = 0;
  private readonly projectileReplayBySequence = new Map<
    number,
    ProjectileReplayEvent[]
  >();
  private readonly recentProjectileDamageById = new Map<string, unknown>();

  /**
   * Registered event handlers for cleanup.
   * Maps event type to handler function so we can remove them in destroy().
   */
  private eventHandlers: Array<{
    event: string | symbol;
    handler: (payload: unknown) => void;
  }> = [];
  private destroyed = false;

  /**
   * Create an EventBridge
   *
   * @param world - Game world instance that emits events
   * @param broadcast - Broadcast manager for sending messages
   */
  constructor(
    private world: World,
    private broadcast: BroadcastManager,
  ) {}

  /**
   * Register an event handler and track it for cleanup
   * @private
   */
  private on(
    event: keyof EventMap | string,
    handler: (payload: unknown) => void,
  ): void {
    this.world.on(event as keyof EventMap, handler);
    this.eventHandlers.push({ event, handler });
  }

  /**
   * Produce a stable identity that survives delivery through multiple nearby
   * region topics without collapsing separate projectiles fired in one tick.
   */
  private nextProjectileNetworkEventId(): string {
    this.projectileNetworkEventSequence += 1;
    return `${this.projectileNetworkEventSourceId}:${this.projectileNetworkEventSequence}`;
  }

  private recordProjectileReplaySequence(
    sequence: number,
    events: Array<Omit<ProjectileReplayEvent, "sequence">>,
  ): void {
    this.projectileReplayBySequence.set(
      sequence,
      events.map((event) => ({ sequence, ...event })),
    );
    while (
      this.projectileReplayBySequence.size > MAX_PROJECTILE_REPLAY_SEQUENCES
    ) {
      const oldest = this.projectileReplayBySequence.keys().next().value as
        number | undefined;
      if (oldest === undefined) break;
      this.projectileReplayBySequence.delete(oldest);
    }
  }

  private rememberProjectileDamage(projectileId: string, data: unknown): void {
    this.recentProjectileDamageById.set(projectileId, data);
    while (
      this.recentProjectileDamageById.size > MAX_PROJECTILE_REPLAY_SEQUENCES
    ) {
      const oldest = this.recentProjectileDamageById.keys().next().value as
        string | undefined;
      if (oldest === undefined) break;
      this.recentProjectileDamageById.delete(oldest);
    }
  }

  /**
   * Return an exact, bounded range from the current projectile event stream.
   * A response is complete only when every requested lifecycle sequence is
   * still retained; callers can safely replay its stable event identities.
   */
  getProjectileEventReplay(request: {
    sourceId: string;
    fromSequence: number;
    toSequence: number;
  }): ProjectileReplayResponse {
    const fromSequence = Number.isSafeInteger(request.fromSequence)
      ? request.fromSequence
      : 0;
    const toSequence = Number.isSafeInteger(request.toSequence)
      ? request.toSequence
      : -1;
    const validRange =
      fromSequence > 0 &&
      toSequence >= fromSequence &&
      toSequence - fromSequence + 1 <= MAX_PROJECTILE_REPLAY_REQUEST_SEQUENCES;
    const sourceMatches =
      request.sourceId === this.projectileNetworkEventSourceId;
    const response: ProjectileReplayResponse = {
      sourceId: this.projectileNetworkEventSourceId,
      requestedFromSequence: fromSequence,
      requestedToSequence: toSequence,
      complete: validRange && sourceMatches,
      events: [],
    };

    if (!response.complete) return response;

    for (let sequence = fromSequence; sequence <= toSequence; sequence += 1) {
      const events = this.projectileReplayBySequence.get(sequence);
      if (!events) {
        response.complete = false;
        continue;
      }
      response.events.push(...events);
    }
    return response;
  }

  /**
   * Cleanup all registered event listeners.
   * MUST be called when the ServerNetwork system is destroyed to prevent memory leaks.
   */
  destroy(): void {
    this.destroyed = true;
    for (const { event, handler } of this.eventHandlers) {
      this.world.off(event as keyof EventMap, handler as () => void);
    }
    this.eventHandlers = [];
    this.recentDamageEvents.clear();
    this.projectileReplayBySequence.clear();
    this.recentProjectileDamageById.clear();
  }

  /**
   * Get database from world object
   *
   * @private
   */
  private getDatabase(): {
    drizzle: NodePgDatabase<typeof schema>;
    pool: pg.Pool;
  } | null {
    const serverWorld = this.world as {
      pgPool?: pg.Pool;
      drizzleDb?: NodePgDatabase<typeof schema>;
    };

    if (serverWorld.drizzleDb && serverWorld.pgPool) {
      return {
        drizzle: serverWorld.drizzleDb,
        pool: serverWorld.pgPool,
      };
    }

    return null;
  }

  /**
   * Setup all event listeners
   *
   * Registers listeners for all world events that need to be
   * forwarded to clients. Call this once during initialization.
   */
  setupEventListeners(): void {
    this.setupResourceEvents();
    this.setupInventoryEvents();
    this.setupSkillEvents();
    this.setupPrayerEvents();
    this.setupUIEvents();
    this.setupCombatEvents();
    this.setupPlayerEvents();
    this.setupDialogueEvents();
    this.setupBankingEvents();
    this.setupStoreEvents();
    this.setupFireEvents();
    this.setupSmeltingEvents();
    this.setupCraftingEvents();
    this.setupFletchingEvents();
    this.setupTanningEvents();
    this.setupRunecraftingEvents();
    this.setupProcessingProgressEvents();
    this.setupProcessingRejectionEvents();
    this.setupQuestEvents();
    this.setupTradeEvents();
  }

  /**
   * Setup resource system event listeners
   *
   * Forwards resource depletion, respawn, and spawn point events
   * to all connected clients.
   *
   * @private
   */
  private setupResourceEvents(): void {
    try {
      this.on(EventType.RESOURCE_DEPLETED, (payload: unknown) => {
        this.sendResourceEvent("resourceDepleted", payload);
      });

      this.on(EventType.RESOURCE_RESPAWNED, (payload: unknown) => {
        this.sendResourceEvent("resourceRespawned", payload);
      });

      this.on(EventType.RESOURCE_SPAWNED, (payload: unknown) => {
        this.sendResourceEvent("resourceSpawned", payload);
      });

      // Use tracked this.on() for proper cleanup in destroy()
      this.on(
        EventType.RESOURCE_SPAWN_POINTS_REGISTERED,
        (...args: unknown[]) => {
          this.broadcast.sendToAll("resourceSpawnPoints", args[0]);
        },
      );

      // Gathering tools are public action visuals. Nearby players and anonymous
      // stream spectators must receive the same authoritative transition.
      this.on(EventType.GATHERING_TOOL_SHOW, (payload: unknown) => {
        const data = payload as EventMap[EventType.GATHERING_TOOL_SHOW];
        if (data.playerId) {
          this.sendGatheringToolEvent("gatheringToolShow", data);
        }
      });

      this.on(EventType.GATHERING_TOOL_HIDE, (payload: unknown) => {
        const data = payload as EventMap[EventType.GATHERING_TOOL_HIDE];
        if (data.playerId) {
          this.sendGatheringToolEvent("gatheringToolHide", data);
        }
      });

      this.on(
        EventType.FISHING_INTERACTION_PRESENTATION,
        (payload: unknown) => {
          const data =
            payload as EventMap[EventType.FISHING_INTERACTION_PRESENTATION];
          if (data.playerId) {
            this.sendGatheringPresentationEvent(
              "fishingInteractionPresentation",
              data,
            );
          }
        },
      );

      this.on(
        EventType.PROCESSING_INTERACTION_PRESENTATION,
        (payload: unknown) => {
          const data =
            payload as EventMap[EventType.PROCESSING_INTERACTION_PRESENTATION];
          if (data.playerId) {
            this.sendGatheringPresentationEvent(
              "processingInteractionPresentation",
              data,
            );
          }
        },
      );
    } catch (_err) {
      console.error("[EventBridge] Error setting up resource events:", _err);
    }
  }

  /**
   * Setup inventory system event listeners
   *
   * Handles inventory updates, initialization, and request events.
   * Routes messages to specific players when needed.
   *
   * @private
   */
  private setupInventoryEvents(): void {
    try {
      // Send inventory updates to specific player only (not all clients!)
      this.on(EventType.INVENTORY_UPDATED, (payload: unknown) => {
        const data = payload as EventMap[EventType.INVENTORY_UPDATED];
        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "inventoryUpdated", data);
        }
      });

      this.on(EventType.ITEM_DROP_RESULT, (payload: unknown) => {
        const data = payload as EventMap[EventType.ITEM_DROP_RESULT];
        if (data.playerId) {
          this.broadcast.sendToPlayer(
            data.playerId,
            "groundItemDropResult",
            data,
          );
        }
      });

      // Send inventory initialization to specific player
      this.on(EventType.INVENTORY_INITIALIZED, (payload: unknown) => {
        const data = payload as EventMap[EventType.INVENTORY_INITIALIZED];

        const packet = {
          playerId: data.playerId,
          items: data.inventory.items,
          coins: data.inventory.coins,
          maxSlots: data.inventory.maxSlots,
        };

        // Send inventory update to player AND spectators
        this.broadcast.sendToPlayerAndSpectators(
          data.playerId,
          "inventoryUpdated",
          packet,
        );
      });

      // Handle coin updates - send to specific player
      this.on(EventType.INVENTORY_COINS_UPDATED, (payload: unknown) => {
        const data = payload as EventMap[EventType.INVENTORY_COINS_UPDATED];
        // Send coins update to the specific player
        this.broadcast.sendToPlayer(data.playerId, "coinsUpdated", {
          playerId: data.playerId,
          coins: data.coins,
        });
      });

      // Handle inventory data requests
      this.on(EventType.INVENTORY_REQUEST, (payload: unknown) => {
        const data = payload as EventMap[EventType.INVENTORY_REQUEST];

        try {
          const invSystem = this.world.getSystem?.("inventory") as
            | {
                getInventoryData?: (id: string) => {
                  items: unknown[];
                  coins: number;
                  maxSlots: number;
                };
                isInventoryReady?: (id: string) => boolean;
              }
            | undefined;

          // CRITICAL: Don't respond if inventory is currently being loaded from DB
          // The INVENTORY_INITIALIZED event will send the complete inventory when ready
          if (
            invSystem?.isInventoryReady &&
            !invSystem.isInventoryReady(data.playerId)
          ) {
            // Inventory is being loaded - don't send potentially stale/empty data
            // The INVENTORY_INITIALIZED event will be emitted when loading completes
            return;
          }

          const inv = invSystem?.getInventoryData
            ? invSystem.getInventoryData(data.playerId)
            : { items: [], coins: 0, maxSlots: 28 };

          const packet = {
            playerId: data.playerId,
            items: inv.items,
            coins: inv.coins,
            maxSlots: inv.maxSlots,
          };

          // Send inventory update to player AND spectators
          this.broadcast.sendToPlayerAndSpectators(
            data.playerId,
            "inventoryUpdated",
            packet,
          );
        } catch (_err) {
          console.error(
            "[EventBridge] Error handling inventory request:",
            _err,
          );
        }
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up inventory events:", _err);
    }
  }

  /**
   * Setup skill system event listeners
   *
   * Routes skill updates to specific players or broadcasts to all.
   *
   * @private
   */
  private setupSkillEvents(): void {
    try {
      this.on(EventType.SKILLS_UPDATED, (payload: unknown) => {
        const data = payload as EventMap[EventType.SKILLS_UPDATED];

        if (data?.playerId) {
          // Send to specific player AND spectators watching them
          this.broadcast.sendToPlayerAndSpectators(
            data.playerId,
            "skillsUpdated",
            data,
          );
        } else {
          // Broadcast to all
          this.broadcast.sendToAll("skillsUpdated", payload);
        }
      });

      // Forward XP drops to clients for visual feedback (modern MMORPG-style)
      // Uses XP_DROP_BROADCAST which is emitted AFTER SkillsSystem processes XP
      // This ensures newLevel reflects any level-ups that occurred
      this.on(EventType.XP_DROP_BROADCAST, (payload: unknown) => {
        const data = payload as EventMap[EventType.XP_DROP_BROADCAST];

        if (!data?.playerId) return;

        // Send XP drop to the player AND spectators for visual feedback
        // Spectators watching the player should see XP orbs too
        this.broadcast.sendToPlayerAndSpectators(data.playerId, "xpDrop", {
          skill: data.skill,
          xpGained: data.amount,
          newXp: data.newXp,
          newLevel: data.newLevel,
          position: data.position,
        });

        // Persist skill XP to database with retry (only if values are valid)
        const dbSystem = this.world.getSystem("database") as {
          savePlayer?: (
            playerId: string,
            data: Record<string, unknown>,
          ) => void;
        };
        // Prayer progression reaches this visual event only after the atomic
        // bone/prayer custody receipt has committed XP, level, and points in
        // one transaction. A second generic save is both redundant and
        // forbidden because it could overwrite newer prayer custody state.
        const progressionAlreadyCommittedAtomically = data.skill === "prayer";
        if (
          dbSystem?.savePlayer &&
          !progressionAlreadyCommittedAtomically &&
          Number.isFinite(data.newXp) &&
          Number.isFinite(data.newLevel)
        ) {
          // Map skill name to database column names
          // Round XP to integer at DB boundary (XP columns are integer type,
          // but recipes use float values like 13.8, 67.5 for classic MMORPG accuracy)
          const skillLevelKey = `${data.skill}Level`;
          const skillXpKey = `${data.skill}Xp`;
          const saveData = {
            [skillLevelKey]: data.newLevel,
            [skillXpKey]: Math.round(data.newXp),
          };

          // Attempt save with retry on failure (fire-and-forget)
          const attemptSave = (attempt: number): void => {
            try {
              dbSystem.savePlayer!(data.playerId, saveData);
            } catch (err) {
              if (attempt < 2) {
                const delay = Math.pow(2, attempt) * 100;
                setTimeout(() => attemptSave(attempt + 1), delay);
              } else {
                console.error(
                  `[EventBridge] Failed to persist XP after 3 attempts for ${data.playerId}:`,
                  err,
                );
              }
            }
          };
          attemptSave(0);
        }
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up skill events:", _err);
    }
  }

  /**
   * Setup prayer event listeners
   *
   * Routes prayer state changes to specific players.
   *
   * @private
   */
  private setupPrayerEvents(): void {
    try {
      // Forward prayer state sync to clients
      this.on(EventType.PRAYER_STATE_SYNC, (payload: unknown) => {
        const data = payload as EventMap[EventType.PRAYER_STATE_SYNC];

        if (!data?.playerId) return;

        // Send prayer state to the specific player
        this.broadcast.sendToPlayer(data.playerId, "prayerStateSync", {
          playerId: data.playerId,
          points: data.points ?? 0,
          maxPoints: data.maxPoints ?? 1,
          active: data.active ?? [],
        });
      });

      // Forward prayer toggled events for visual feedback
      this.on(EventType.PRAYER_TOGGLED, (payload: unknown) => {
        const data = payload as EventMap[EventType.PRAYER_TOGGLED];

        if (!data?.playerId) return;

        // Send toggle confirmation to the player
        this.broadcast.sendToPlayer(data.playerId, "prayerToggled", {
          playerId: data.playerId,
          prayerId: data.prayerId,
          active: data.active,
          points: data.points,
        });
      });

      // Forward prayer points changes for real-time drain animation
      this.on(EventType.PRAYER_POINTS_CHANGED, (payload: unknown) => {
        const data = payload as EventMap[EventType.PRAYER_POINTS_CHANGED];

        if (!data?.playerId) return;

        // Send point update to the player
        this.broadcast.sendToPlayer(data.playerId, "prayerPointsChanged", {
          playerId: data.playerId,
          points: data.points ?? 0,
          maxPoints: data.maxPoints ?? 1,
          reason: data.reason,
        });
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up prayer events:", _err);
    }
  }

  /**
   * Setup UI event listeners
   *
   * Routes UI updates to specific players when player component changes.
   *
   * @private
   */
  private setupUIEvents(): void {
    try {
      // Forward UI_MESSAGE events to chat (system messages, warnings, etc.)
      this.on(EventType.UI_MESSAGE, (payload: unknown) => {
        const data = payload as EventMap[EventType.UI_MESSAGE];

        if (data.playerId && data.message) {
          this.broadcast.sendToPlayer(data.playerId, "systemMessage", {
            message: data.message,
            type: data.type || "info",
          });
        }
      });

      // Forward UI_TOAST events to client for toast notifications
      this.on(EventType.UI_TOAST, (payload: unknown) => {
        const data = payload as EventMap[EventType.UI_TOAST];

        if (data.playerId && data.message) {
          this.broadcast.sendToPlayer(data.playerId, "showToast", {
            message: data.message,
            type: data.type || "info",
          });
        }
      });

      this.on(EventType.UI_UPDATE, (payload: unknown) => {
        const data = payload as EventMap[EventType.UI_UPDATE] | undefined;
        const inner = data?.data as
          { playerId?: string; [k: string]: unknown } | undefined;

        if (data?.component === "player" && inner?.playerId) {
          this.broadcast.sendToPlayer(inner.playerId, "playerState", inner);
        }
      });

      // Forward death screen events to specific player
      this.on(EventType.UI_DEATH_SCREEN, (payload: unknown) => {
        const data = payload as EventMap[EventType.UI_DEATH_SCREEN];

        if (data.playerId) {
          // Send death screen to player AND spectators
          this.broadcast.sendToPlayerAndSpectators(
            data.playerId,
            "deathScreen",
            data,
          );
        }
      });

      // Forward death screen close events to specific player AND spectators
      this.on(EventType.UI_DEATH_SCREEN_CLOSE, (payload: unknown) => {
        const data = payload as EventMap[EventType.UI_DEATH_SCREEN_CLOSE];

        if (data.playerId) {
          // Send death screen close to player AND spectators
          this.broadcast.sendToPlayerAndSpectators(
            data.playerId,
            "deathScreenClose",
            data,
          );
        }
      });

      // Forward player death state changes to ALL clients
      // CRITICAL: Broadcast to all so other players see death animation and position updates
      this.on(EventType.PLAYER_SET_DEAD, (payload: unknown) => {
        const data = payload as EventMap[EventType.PLAYER_SET_DEAD];

        if (data.playerId) {
          const sendDeathState = () => {
            if (this.destroyed) return;

            // Broadcast to ALL players so they can:
            // 1. See death animation on the dying player
            // 2. Clear tile interpolator state (allows respawn position to apply)
            this.broadcast.sendToAll(
              "playerSetDead",
              {
                playerId: data.playerId,
                isDead: data.isDead,
                deathPosition: data.deathPosition,
              },
              undefined,
              PacketPriority.CRITICAL,
            );

            if (data.isDead) {
              // Also broadcast entityModified with death animation. Without this,
              // remote players wait for the next dirty-entity sync cycle.
              this.broadcast.sendToAll(
                "entityModified",
                {
                  id: data.playerId,
                  changes: {
                    e: "death",
                  },
                },
                undefined,
                PacketPriority.CRITICAL,
              );
            }
          };

          if (data.isDead) {
            // Health application emits PLAYER_SET_DEAD before CombatSystem emits
            // the killing COMBAT_DAMAGE_DEALT / COMBAT_PROJECTILE_HIT events.
            // Preserve synchronous authoritative server death state, but defer
            // only its network presentation so contact and the terminal splat
            // reach clients before the death pose begins.
            const deathPosition = Array.isArray(data.deathPosition)
              ? [...data.deathPosition]
              : data.deathPosition
                ? { ...data.deathPosition }
                : undefined;
            const deathData = {
              playerId: data.playerId,
              isDead: true,
              deathPosition,
            };
            globalThis.queueMicrotask(() => {
              if (this.destroyed) return;
              this.broadcast.sendToAll(
                "playerSetDead",
                deathData,
                undefined,
                PacketPriority.CRITICAL,
              );
              this.broadcast.sendToAll(
                "entityModified",
                {
                  id: deathData.playerId,
                  changes: { e: "death" },
                },
                undefined,
                PacketPriority.CRITICAL,
              );
            });
          } else {
            sendDeathState();
          }
        }
      });

      // Forward player respawn events to ALL clients
      // CRITICAL: Broadcast to all so other players see respawned player at new position
      this.on(EventType.PLAYER_RESPAWNED, (payload: unknown) => {
        const data = payload as EventMap[EventType.PLAYER_RESPAWNED];

        if (data.playerId) {
          // Broadcast to ALL players so they can see the respawned player
          this.broadcast.sendToAll(
            "playerRespawned",
            data,
            undefined,
            PacketPriority.CRITICAL,
          );
        }
      });

      // Forward attack style change events to specific player
      this.on(EventType.UI_ATTACK_STYLE_CHANGED, (payload: unknown) => {
        const data = payload as EventMap[EventType.UI_ATTACK_STYLE_CHANGED];

        if (data.playerId) {
          this.broadcast.sendToPlayer(
            data.playerId,
            "attackStyleChanged",
            data,
          );
        }
      });

      // Forward attack style update events to specific player
      this.on(EventType.UI_ATTACK_STYLE_UPDATE, (payload: unknown) => {
        const data = payload as EventMap[EventType.UI_ATTACK_STYLE_UPDATE];

        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "attackStyleUpdate", data);
        }
      });

      // Forward auto-retaliate change events to specific player
      this.on(EventType.UI_AUTO_RETALIATE_CHANGED, (payload: unknown) => {
        const data = payload as EventMap[EventType.UI_AUTO_RETALIATE_CHANGED];

        // Defensive validation before sending to client
        if (!data.playerId || typeof data.enabled !== "boolean") {
          console.warn(
            "[EventBridge] Invalid AUTO_RETALIATE_CHANGED payload:",
            data,
          );
          return;
        }

        this.broadcast.sendToPlayer(data.playerId, "autoRetaliateChanged", {
          enabled: data.enabled,
        });
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up UI events:", _err);
    }
  }

  /**
   * Setup combat system event listeners
   *
   * Forwards combat damage events to all connected clients for visual feedback
   * (damage splats, hit effects, etc.)
   *
   * @private
   */
  private setupCombatEvents(): void {
    try {
      // Forward damage dealt events to all clients for visual effects
      this.on(EventType.COMBAT_DAMAGE_DEALT, (payload: unknown) => {
        const data = payload as EventMap[EventType.COMBAT_DAMAGE_DEALT];

        // Deduplicate damage events to prevent duplicate splats
        // This can happen when both initial attack and auto-attack processing
        // fire for the same attack within the same tick
        const currentTick = this.world.currentTick;
        // Stable projectile identity is the only safe dedupe key for delayed
        // ranged/magic damage. Two authoritative projectiles may legitimately
        // land on the same pair, for the same amount, in one tick. The legacy
        // tuple remains for melee/rolling-deploy payloads without an identity.
        const dedupeKey = data.projectileId
          ? `projectile|${data.projectileId}`
          : [
              "legacy",
              data.attackerId,
              data.targetId,
              currentTick,
              data.damage,
              data.attackType ?? "",
            ].join("|");

        // Cleanup old entries every tick (entries older than 2 ticks)
        // More aggressive cleanup to prevent memory buildup
        if (currentTick > this.lastCleanupTick) {
          for (const [key, tick] of this.recentDamageEvents) {
            if (tick < currentTick - 1) {
              this.recentDamageEvents.delete(key);
            }
          }
          this.lastCleanupTick = currentTick;
        }

        // Safety cap: prevent unbounded memory growth with aggressive eviction
        // 256 entries covers ~128 concurrent combatants at 2 ticks retention
        if (this.recentDamageEvents.size > 256) {
          let evicted = 0;
          const evictTarget = Math.floor(this.recentDamageEvents.size * 0.75);
          for (const [key] of this.recentDamageEvents) {
            this.recentDamageEvents.delete(key);
            if (++evicted >= evictTarget) break;
          }
        }

        if (this.recentDamageEvents.has(dedupeKey)) {
          // Duplicate event - skip broadcasting
          return;
        }

        this.recentDamageEvents.set(dedupeKey, currentTick);

        // Resolve position: prefer event payload, fall back to entity lookup.
        // Position is required for sendToNearby (spatial broadcast) and for
        // the client-side DamageSplatSystem to render the hit splat.
        let pos = data.position;
        if (!pos) {
          const target = this.world.entities?.get(data.targetId);
          if (target) {
            const ep = (
              target as { position?: { x: number; y: number; z: number } }
            ).position;
            if (ep) {
              pos = { x: ep.x, y: ep.y, z: ep.z };
            }
          }
        }

        // Broadcast to nearby clients so they see the damage splat
        if (pos) {
          // Snapshot position as a plain object to avoid serializing
          // mutable Vector3 references that could change.
          const broadcastData = {
            ...(data.projectileId ? { projectileId: data.projectileId } : {}),
            attackerId: data.attackerId,
            targetId: data.targetId,
            damage: data.damage,
            attackType: data.attackType,
            targetType: data.targetType,
            isCritical: data.isCritical,
            position: { x: pos.x, y: pos.y, z: pos.z },
            tick: currentTick,
          };
          if (data.projectileId) {
            this.rememberProjectileDamage(data.projectileId, broadcastData);
          }
          this.broadcast.sendToNearby(
            "combatDamageDealt",
            broadcastData,
            pos.x,
            pos.z,
            undefined,
            PacketPriority.CRITICAL,
          );
        }
      });

      // Forward projectile launched events to all clients for visual effects (arrows, spells)
      // Use tracked this.on() for proper cleanup in destroy()
      this.on(EventType.COMBAT_PROJECTILE_LAUNCHED, (payload: unknown) => {
        const data = payload as EventMap[EventType.COMBAT_PROJECTILE_LAUNCHED];
        const networkEventId = this.nextProjectileNetworkEventId();
        const broadcastData = {
          ...data,
          tick: this.world.currentTick,
          networkEventId,
        };

        this.recordProjectileReplaySequence(
          this.projectileNetworkEventSequence,
          [{ name: "projectileLaunched", data: broadcastData }],
        );

        // Broadcast to nearby clients so they see the projectile
        this.broadcast.sendToNearby(
          "projectileLaunched",
          broadcastData,
          data.sourcePosition.x,
          data.sourcePosition.z,
          undefined,
          PacketPriority.CRITICAL,
        );
      });

      // The launch payload carries the expected flight duration, but the
      // authoritative impact remains the server's projectile tick. Forward it
      // explicitly so clients remove the visual on the same event that applies
      // damage instead of relying on frame-rate-dependent local arrival.
      this.on(EventType.COMBAT_PROJECTILE_HIT, (payload: unknown) => {
        const data = payload as EventMap[EventType.COMBAT_PROJECTILE_HIT];
        const target = this.world.entities?.get(data.targetId) as
          { position?: { x: number; y: number; z: number } } | undefined;
        const position = data.position ?? target?.position ?? null;
        const networkEventId = this.nextProjectileNetworkEventId();
        const broadcastData = {
          projectileId: data.projectileId,
          attackerId: data.attackerId,
          targetId: data.targetId,
          damage: data.damage,
          projectileType: data.projectileType,
          position: position
            ? { x: position.x, y: position.y, z: position.z }
            : null,
          tick: this.world.currentTick,
          networkEventId,
        };
        const replayEvents: Array<Omit<ProjectileReplayEvent, "sequence">> = [];
        const pairedDamage = data.projectileId
          ? this.recentProjectileDamageById.get(data.projectileId)
          : undefined;
        if (pairedDamage) {
          replayEvents.push({ name: "combatDamageDealt", data: pairedDamage });
        }
        replayEvents.push({ name: "projectileHit", data: broadcastData });
        this.recordProjectileReplaySequence(
          this.projectileNetworkEventSequence,
          replayEvents,
        );
        if (data.projectileId) {
          this.recentProjectileDamageById.delete(data.projectileId);
        }

        if (position) {
          this.broadcast.sendToNearby(
            "projectileHit",
            broadcastData,
            position.x,
            position.z,
            undefined,
            PacketPriority.CRITICAL,
          );
        } else {
          // A terminal hit can remove the target entity before this listener
          // runs. Full broadcast is rare and prevents a stuck projectile when
          // there is no remaining spatial anchor.
          this.broadcast.sendToAll(
            "projectileHit",
            broadcastData,
            undefined,
            PacketPriority.CRITICAL,
          );
        }
      });

      // Every accepted launch has an authoritative terminal event. When
      // combat teardown invalidates a queued hit, forward the exact projectile
      // identity so clients remove only that visual instead of timing it out.
      this.on(EventType.COMBAT_PROJECTILE_CANCELLED, (payload: unknown) => {
        const data = payload as EventMap[EventType.COMBAT_PROJECTILE_CANCELLED];
        const anchor = (this.world.entities?.get(data.targetId) ??
          this.world.entities?.get(data.attackerId)) as
          { position?: { x: number; y: number; z: number } } | undefined;
        const networkEventId = this.nextProjectileNetworkEventId();
        const broadcastData = {
          ...data,
          tick: this.world.currentTick,
          networkEventId,
        };

        this.recordProjectileReplaySequence(
          this.projectileNetworkEventSequence,
          [{ name: "projectileCancelled", data: broadcastData }],
        );
        this.recentProjectileDamageById.delete(data.projectileId);

        if (anchor?.position) {
          this.broadcast.sendToNearby(
            "projectileCancelled",
            broadcastData,
            anchor.position.x,
            anchor.position.z,
            undefined,
            PacketPriority.CRITICAL,
          );
        } else {
          this.broadcast.sendToAll(
            "projectileCancelled",
            broadcastData,
            undefined,
            PacketPriority.CRITICAL,
          );
        }
      });

      // Forward combat face target events so clients rotate toward their target
      // Essential for magic/ranged attacks where player is stationary
      this.on(EventType.COMBAT_FACE_TARGET, (payload: unknown) => {
        const data = payload as EventMap[EventType.COMBAT_FACE_TARGET];

        // The controlling player and the streaming spectators both render this
        // authoritative target choice. Anonymous stream viewers subscribe to the
        // generic spectator topic rather than spectator:<playerId>, so routing
        // through sendToPlayerAndSpectators would leave the arena broadcast with
        // no target-facing information.
        this.broadcast.sendToPlayer(
          data.playerId,
          "combatFaceTarget",
          data,
          PacketPriority.CRITICAL,
        );
        this.broadcast.sendToSpectators(
          "combatFaceTarget",
          data,
          PacketPriority.CRITICAL,
        );
      });

      // Forward combat clear face target so clients stop rotating toward dead/disengaged targets
      this.on(EventType.COMBAT_CLEAR_FACE_TARGET, (payload: unknown) => {
        const data = payload as EventMap[EventType.COMBAT_CLEAR_FACE_TARGET];
        this.broadcast.sendToPlayer(
          data.playerId,
          "combatClearFaceTarget",
          data,
          PacketPriority.CRITICAL,
        );
        this.broadcast.sendToSpectators(
          "combatClearFaceTarget",
          data,
          PacketPriority.CRITICAL,
        );
      });

      // Forward combat ended so clients/agents can clear inCombat flag
      this.on(EventType.COMBAT_ENDED, (payload: unknown) => {
        const data = payload as EventMap[EventType.COMBAT_ENDED];
        if (data.attackerId) {
          const combatEnded = {
            attackerId: data.attackerId,
            targetId: data.targetId,
          };
          this.broadcast.sendToPlayer(
            data.attackerId,
            "combatEnded",
            combatEnded,
            PacketPriority.CRITICAL,
          );
          this.broadcast.sendToSpectators(
            "combatEnded",
            combatEnded,
            PacketPriority.CRITICAL,
          );
        }
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up combat events:", _err);
    }
  }

  /**
   * Setup player system event listeners
   *
   * Forwards player state updates (health, stats, etc.) to specific players
   *
   * @private
   */
  private setupPlayerEvents(): void {
    try {
      // Forward weight changes to specific player (for stamina drain calculations)
      this.on(EventType.PLAYER_WEIGHT_CHANGED, (payload: unknown) => {
        const data = payload as EventMap[EventType.PLAYER_WEIGHT_CHANGED];

        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "playerWeightUpdated", {
            playerId: data.playerId,
            weight: data.weight,
          });
        }
      });

      // Forward player updates to specific player (health, stats, etc.)
      // Note: emitPlayerUpdate() sends { playerId, component, data: playerData }
      // where data.health is { current, max } object
      this.on(EventType.PLAYER_UPDATED, (payload: unknown) => {
        const data = payload as EventMap[EventType.PLAYER_UPDATED];

        if (data.playerId && data.data) {
          const playerData = data.data as {
            health: { current: number; max: number };
            alive: boolean;
          };

          // Send to specific player AND spectators with flat health values for client
          this.broadcast.sendToPlayerAndSpectators(
            data.playerId,
            "playerUpdated",
            {
              health: playerData.health.current,
              maxHealth: playerData.health.max,
              alive: playerData.alive,
            },
          );
        }
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up player events:", _err);
    }
  }

  /**
   * Setup dialogue system event listeners
   *
   * Forwards dialogue events (start, node change, end) to specific players
   * for the DialoguePanel UI component.
   *
   * @private
   */
  private setupDialogueEvents(): void {
    try {
      // Forward dialogue start events to specific player
      this.on(EventType.DIALOGUE_START, (payload: unknown) => {
        const data = payload as EventMap[EventType.DIALOGUE_START];

        if (data.playerId) {
          // Pass npcEntityId for live position lookup on client (like bank does)
          this.broadcast.sendToPlayer(data.playerId, "dialogueStart", {
            npcId: data.npcId,
            npcName: data.npcName,
            nodeId: data.nodeId,
            text: data.text,
            responses: data.responses,
            npcEntityId: data.npcEntityId,
          });
        }
      });

      // Forward dialogue node change events to specific player
      this.on(EventType.DIALOGUE_NODE_CHANGE, (payload: unknown) => {
        const data = payload as EventMap[EventType.DIALOGUE_NODE_CHANGE];

        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "dialogueNodeChange", {
            npcId: data.npcId,
            nodeId: data.nodeId,
            text: data.text,
            responses: data.responses,
          });
        }
      });

      // Forward dialogue end events to specific player
      this.on(EventType.DIALOGUE_END, (payload: unknown) => {
        const data = payload as EventMap[EventType.DIALOGUE_END];

        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "dialogueEnd", {
            npcId: data.npcId,
          });
        }
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up dialogue events:", _err);
    }
  }

  /**
   * Setup banking system event listeners
   *
   * Handles bank open requests from dialogue effects and other sources.
   * Queries the database for player's bank items and sends bankState to client.
   *
   * @private
   */
  private setupBankingEvents(): void {
    try {
      // Handle bank open requests (from dialogue effects, NPC interactions, etc.)
      this.on(EventType.BANK_OPEN_REQUEST, async (payload: unknown) => {
        const data = payload as EventMap[EventType.BANK_OPEN_REQUEST];

        if (!data.playerId) {
          console.warn("[EventBridge] BANK_OPEN_REQUEST missing playerId");
          return;
        }

        try {
          // Query database for player's bank items (universal bank - same as BankEntity)
          const db = this.getDatabase();
          if (!db) {
            console.error(
              "[EventBridge] No database available for bank operation",
            );
            return;
          }

          const bankRepo = new BankRepository(db.drizzle, db.pool);
          const items = await bankRepo.getPlayerBank(data.playerId);

          // Send bankState to player (same format as handleBankOpen in bank.ts)
          // Use npcEntityId for distance checking if available (from dialogue), otherwise use spawn_bank
          this.broadcast.sendToPlayer(data.playerId, "bankState", {
            playerId: data.playerId,
            bankId: data.npcEntityId || "spawn_bank",
            items,
            maxSlots: 480,
          });
        } catch (err) {
          console.error("[EventBridge] Error fetching bank data:", err);
        }
      });

      // Send bank contents on player spawn so agents know what's in bank
      // without having to physically open it first
      // Use tracked this.on() for proper cleanup in destroy()
      this.on(EventType.PLAYER_SPAWNED, async (payload: unknown) => {
        const data = payload as { playerId?: string };
        if (!data.playerId) return;

        try {
          const db = this.getDatabase();
          if (!db) return;

          const bankRepo = new BankRepository(db.drizzle, db.pool);
          const items = await bankRepo.getPlayerBank(data.playerId);

          this.broadcast.sendToPlayer(data.playerId, "bankState", {
            playerId: data.playerId,
            bankId: "spawn_sync",
            items,
            maxSlots: 480,
          });
        } catch (_err) {
          // Database may not be ready during early spawn — silently ignore
        }
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up banking events:", _err);
    }
  }

  /**
   * Setup store system event listeners
   *
   * Handles store open requests from dialogue effects.
   * Looks up store data and sends storeState to client.
   *
   * @private
   */
  private setupStoreEvents(): void {
    try {
      this.on(EventType.STORE_OPEN_REQUEST, async (payload: unknown) => {
        const data = payload as EventMap[EventType.STORE_OPEN_REQUEST];

        if (!data.playerId) {
          console.warn("[EventBridge] STORE_OPEN_REQUEST missing playerId");
          return;
        }

        // Get storeId - either from event or look up from NPC
        let storeId = data.storeId;
        if (!storeId) {
          // First try with the npcId directly (might be manifest ID)
          storeId = this.getStoreIdForNpc(data.npcId);

          // If not found and we have npcEntityId, look up the entity to get manifest npcId
          if (!storeId && data.npcEntityId) {
            const manifestNpcId = this.getManifestNpcIdFromEntity(
              data.npcEntityId,
            );
            if (manifestNpcId) {
              storeId = this.getStoreIdForNpc(manifestNpcId);
            }
          }
        }

        if (!storeId) {
          console.warn(
            `[EventBridge] No store linked to NPC ${data.npcId} (entityId: ${data.npcEntityId})`,
          );
          return;
        }

        // Get store data from StoreSystem
        const storeSystem = this.world.getSystem("store") as
          StoreSystem | undefined;
        const store = storeSystem?.getStore(storeId);

        if (!store) {
          console.warn(`[EventBridge] Store not found: ${storeId}`);
          return;
        }

        // InteractionSessionManager now tracks targetEntityId as single source of truth
        // (It listens to STORE_OPEN_REQUEST and creates session with targetEntityId = npcEntityId)

        // Send storeState packet to player (include npcEntityId for distance checking)
        this.broadcast.sendToPlayer(data.playerId, "storeState", {
          storeId: store.id,
          storeName: store.name,
          buybackRate: store.buybackRate,
          items: store.items,
          isOpen: true,
          npcEntityId: data.npcEntityId,
        });
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up store events:", _err);
    }
  }

  /**
   * Look up storeId for an NPC from world areas
   */
  private getStoreIdForNpc(npcId: string): string | undefined {
    // ALL_WORLD_AREAS is flat: Record<string, WorldArea>
    for (const area of Object.values(ALL_WORLD_AREAS)) {
      const typedArea = area as {
        npcs?: Array<{ id: string; storeId?: string }>;
      };
      const npc = typedArea.npcs?.find((n) => n.id === npcId);
      if (npc?.storeId) return npc.storeId;
    }
    return undefined;
  }

  /**
   * Get manifest npcId from an NPC entity by its entity ID
   *
   * NPC entities store their manifest ID (e.g., "shopkeeper") in their config/data,
   * while their entity ID includes a timestamp (e.g., "npc_shopkeeper_1765003446078").
   * This method looks up the entity and extracts the manifest ID.
   *
   * Fallback: If entity lookup fails, parse the manifest ID from the entity ID format.
   */
  private getManifestNpcIdFromEntity(entityId: string): string | undefined {
    // First try to look up the entity and get npcId from its config/data
    const entity = this.world.entities?.get?.(entityId);
    if (entity) {
      // Try to get npcId from various possible locations on the entity
      // Cast through unknown because Entity.config is protected but NPCEntity.config is public
      const entityWithConfig = entity as unknown as {
        config?: { npcId?: string };
        data?: { npcId?: string };
        npcId?: string;
      };

      const npcId =
        entityWithConfig.config?.npcId ||
        entityWithConfig.data?.npcId ||
        entityWithConfig.npcId;

      if (npcId) {
        return npcId;
      }
    }

    // Fallback: Parse manifest ID from entity ID format
    // Entity IDs are formatted as: npc_${manifestId}_${timestamp}
    // Example: "npc_shopkeeper_1765003446078" -> "shopkeeper"
    if (entityId.startsWith("npc_")) {
      const parts = entityId.split("_");
      if (parts.length >= 3) {
        // The manifest ID is everything between "npc_" and the final timestamp
        // Handle cases like "npc_bank_clerk_1234" -> "bank_clerk"
        const timestampPart = parts[parts.length - 1];
        // Check if the last part looks like a timestamp (all digits, 13+ chars)
        if (/^\d{13,}$/.test(timestampPart)) {
          // Remove "npc_" prefix and "_timestamp" suffix
          const manifestId = parts.slice(1, -1).join("_");
          if (manifestId) {
            return manifestId;
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Look up NPC position from world areas
   */
  private getNpcPositionFromWorldAreas(
    npcId: string,
  ): { x: number; y: number; z: number } | undefined {
    for (const area of Object.values(ALL_WORLD_AREAS)) {
      const typedArea = area as {
        npcs?: Array<{
          id: string;
          position: { x: number; y: number; z: number };
        }>;
      };
      const npc = typedArea.npcs?.find((n) => n.id === npcId);
      if (npc?.position) return npc.position;
    }
    return undefined;
  }

  /**
   * Setup fire/processing event listeners
   *
   * Forwards fire creation and extinguish events to clients
   * for visual fire rendering.
   *
   * @private
   */
  private setupFireEvents(): void {
    try {
      // Broadcast fire lighting started to nearby clients (show model during 3s animation)
      this.on(EventType.FIRE_LIGHTING_STARTED, (payload: unknown) => {
        const data = payload as EventMap[EventType.FIRE_LIGHTING_STARTED];

        this.broadcast.sendToNearby(
          "fireLightingStarted",
          data,
          data.position.x,
          data.position.z,
        );
      });

      // Broadcast fire lighting cancelled to all clients (remove preloaded model)
      this.on(EventType.FIRE_LIGHTING_CANCELLED, (payload: unknown) => {
        const data = payload as EventMap[EventType.FIRE_LIGHTING_CANCELLED];

        this.broadcast.sendToAll("fireLightingCancelled", data);
      });

      // Broadcast fire creation to all clients for visual rendering
      this.on(EventType.FIRE_CREATED, (payload: unknown) => {
        const data = payload as EventMap[EventType.FIRE_CREATED];

        // Send to nearby clients so they can render the fire visual
        this.broadcast.sendToNearby(
          "fireCreated",
          data,
          data.position.x,
          data.position.z,
        );
      });

      // Forward cooking completion to player
      this.on(EventType.COOKING_COMPLETED, (payload: unknown) => {
        const data = payload as EventMap[EventType.COOKING_COMPLETED];
        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "cookingComplete", {
            rawItemId: data.rawItemId,
            resultItemId: data.resultItemId,
            wasBurnt: data.wasBurnt,
            xpGained: data.xpGained,
            ...(data.requestId ? { requestId: data.requestId } : {}),
          });
        }
      });

      // Broadcast fire extinguish to all clients
      this.on(EventType.FIRE_EXTINGUISHED, (payload: unknown) => {
        const data = payload as EventMap[EventType.FIRE_EXTINGUISHED];

        // Send to all clients so they can remove the fire visual
        this.broadcast.sendToAll("fireExtinguished", data);
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up fire events:", _err);
    }
  }

  /**
   * Setup smelting/smithing event listeners
   *
   * Forwards smelting and smithing interface open events to the appropriate player
   * so they can see the available bars/items to craft.
   *
   * @private
   */
  private setupSmeltingEvents(): void {
    try {
      // Forward smelting interface open events to specific player
      this.on(EventType.SMELTING_INTERFACE_OPEN, (payload: unknown) => {
        const data = payload as EventMap[EventType.SMELTING_INTERFACE_OPEN];

        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "smeltingInterfaceOpen", {
            furnaceId: data.furnaceId,
            availableBars: data.availableBars,
          });
        }
      });

      // Forward smithing interface open events to specific player
      this.on(EventType.SMITHING_INTERFACE_OPEN, (payload: unknown) => {
        const data = payload as EventMap[EventType.SMITHING_INTERFACE_OPEN];

        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "smithingInterfaceOpen", {
            anvilId: data.anvilId,
            availableRecipes: data.availableRecipes,
          });
        }
      });
      // Forward smelting completion to player (batch finished)
      this.on(EventType.SMELTING_COMPLETE, (payload: unknown) => {
        const data = payload as EventMap[EventType.SMELTING_COMPLETE];
        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "smeltingComplete", {
            barItemId: data.barItemId,
            totalSmelted: data.totalSmelted,
            totalFailed: data.totalFailed,
            totalXp: data.totalXp,
            ...(data.requestId ? { requestId: data.requestId } : {}),
          });
        }
      });

      // Forward smithing completion to player (batch finished)
      this.on(EventType.SMITHING_COMPLETE, (payload: unknown) => {
        const data = payload as EventMap[EventType.SMITHING_COMPLETE];
        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "smithingComplete", {
            recipeId: data.recipeId,
            outputItemId: data.outputItemId,
            totalSmithed: data.totalSmithed,
            totalXp: data.totalXp,
            ...(data.requestId ? { requestId: data.requestId } : {}),
          });
        }
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up smelting events:", _err);
    }
  }

  /**
   * Setup crafting system event listeners
   *
   * Forwards crafting interface open events to specific players
   * so they can see the crafting UI with available recipes.
   *
   * @private
   */
  private setupCraftingEvents(): void {
    try {
      // Forward crafting interface open events to specific player
      this.on(EventType.CRAFTING_INTERFACE_OPEN, (payload: unknown) => {
        const data = payload as EventMap[EventType.CRAFTING_INTERFACE_OPEN];

        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "craftingInterfaceOpen", {
            availableRecipes: data.availableRecipes,
            station: data.station,
          });
        }
      });
      // Forward crafting completion to player (batch finished)
      this.on(EventType.CRAFTING_COMPLETE, (payload: unknown) => {
        const data = payload as EventMap[EventType.CRAFTING_COMPLETE];
        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "craftingComplete", {
            recipeId: data.recipeId,
            outputItemId: data.outputItemId,
            totalCrafted: data.totalCrafted,
            totalXp: data.totalXp,
            ...(data.requestId ? { requestId: data.requestId } : {}),
          });
        }
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up crafting events:", _err);
    }
  }

  /**
   * Setup fletching system event listeners
   *
   * Forwards fletching interface open events to specific players
   * so they can see the fletching UI with available recipes.
   *
   * @private
   */
  private setupFletchingEvents(): void {
    try {
      // Forward fletching interface open events to specific player
      this.on(EventType.FLETCHING_INTERFACE_OPEN, (payload: unknown) => {
        const data = payload as FletchingInterfaceOpenPayload;

        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "fletchingInterfaceOpen", {
            availableRecipes: data.availableRecipes,
          });
        }
      });
      // Forward fletching completion to player (batch finished)
      this.on(EventType.FLETCHING_COMPLETE, (payload: unknown) => {
        const data = payload as EventMap[EventType.FLETCHING_COMPLETE];
        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "fletchingComplete", {
            recipeId: data.recipeId,
            outputItemId: data.outputItemId,
            totalCrafted: data.totalCrafted,
            totalXp: data.totalXp,
            ...(data.requestId ? { requestId: data.requestId } : {}),
          });
        }
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up fletching events:", _err);
    }
  }

  /**
   * Setup tanning system event listeners
   *
   * Forwards tanning interface open events to specific players
   * so they can see the tanning UI with available hides.
   *
   * @private
   */
  private setupTanningEvents(): void {
    try {
      // Forward tanning interface open events to specific player
      this.on(EventType.TANNING_INTERFACE_OPEN, (payload: unknown) => {
        const data = payload as EventMap[EventType.TANNING_INTERFACE_OPEN];

        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "tanningInterfaceOpen", {
            availableRecipes: data.availableRecipes,
          });
        }
      });
      // Forward tanning completion to player (batch finished)
      this.on(EventType.TANNING_COMPLETE, (payload: unknown) => {
        const data = payload as EventMap[EventType.TANNING_COMPLETE];
        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "tanningComplete", {
            inputItemId: data.inputItemId,
            outputItemId: data.outputItemId,
            totalTanned: data.totalTanned,
            totalCost: data.totalCost,
            ...(data.requestId ? { requestId: data.requestId } : {}),
          });
        }
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up tanning events:", _err);
    }
  }

  /** Forward the authoritative runecrafting transaction result to its player. */
  private setupRunecraftingEvents(): void {
    try {
      this.on(EventType.RUNECRAFTING_COMPLETE, (payload: unknown) => {
        const data = payload as EventMap[EventType.RUNECRAFTING_COMPLETE];
        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "runecraftingComplete", {
            runeType: data.runeType,
            runeItemId: data.runeItemId,
            essenceConsumed: data.essenceConsumed,
            runesProduced: data.runesProduced,
            multiplier: data.multiplier,
            xpAwarded: data.xpAwarded,
            ...(data.requestId ? { requestId: data.requestId } : {}),
          });
        }
      });
    } catch (_err) {
      console.error(
        "[EventBridge] Error setting up runecrafting events:",
        _err,
      );
    }
  }

  /** Forward one typed, request-correlated processing rejection to its player. */
  private setupProcessingRejectionEvents(): void {
    try {
      this.on(EventType.PROCESSING_REQUEST_REJECTED, (payload: unknown) => {
        const data = payload as EventMap[EventType.PROCESSING_REQUEST_REJECTED];
        if (data.playerId && data.requestId) {
          this.broadcast.sendToPlayer(data.playerId, "processingRejected", {
            requestId: data.requestId,
            skill: data.skill,
            reason: data.reason,
            retryable: data.retryable,
          });
        }
      });
    } catch (_err) {
      console.error(
        "[EventBridge] Error setting up processing rejection events:",
        _err,
      );
    }
  }

  /** Forward a safe correlated liveness acknowledgement only to its player. */
  private setupProcessingProgressEvents(): void {
    try {
      this.on(EventType.PROCESSING_REQUEST_PROGRESS, (payload: unknown) => {
        const data = payload as EventMap[EventType.PROCESSING_REQUEST_PROGRESS];
        if (data.playerId && data.requestId) {
          this.broadcast.sendToPlayer(data.playerId, "processingProgress", {
            requestId: data.requestId,
            skill: data.skill,
            phase: data.phase,
          });
        }
      });
    } catch (_err) {
      console.error(
        "[EventBridge] Error setting up processing progress events:",
        _err,
      );
    }
  }

  /**
   * Setup quest system event listeners
   *
   * Forwards quest confirmation screen events to specific players
   * so they can see the quest accept/decline UI.
   *
   * @private
   */
  private setupQuestEvents(): void {
    try {
      // Forward quest start confirmation to specific player
      this.on(EventType.QUEST_START_CONFIRM, (payload: unknown) => {
        const data = payload as EventMap[EventType.QUEST_START_CONFIRM];

        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "questStartConfirm", {
            questId: data.questId,
            questName: data.questName,
            description: data.description,
            difficulty: data.difficulty,
            requirements: data.requirements,
            rewards: data.rewards,
          });
        }
      });

      // Forward quest started event to specific player
      this.on(EventType.QUEST_STARTED, (payload: unknown) => {
        const data = payload as EventMap[EventType.QUEST_STARTED];

        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "questStarted", {
            questId: data.questId,
            questName: data.questName,
          });
        }
      });

      // Forward quest progress updates to specific player
      this.on(EventType.QUEST_PROGRESSED, (payload: unknown) => {
        const data = payload as EventMap[EventType.QUEST_PROGRESSED];

        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "questProgressed", {
            questId: data.questId,
            stage: data.stage,
            progress: data.progress,
            description: data.description,
            stageType: data.stageType,
            stageTarget: data.stageTarget,
            stageCount: data.stageCount,
          });
        }
      });

      // Forward quest completed event to specific player
      this.on(EventType.QUEST_COMPLETED, (payload: unknown) => {
        const data = payload as EventMap[EventType.QUEST_COMPLETED];

        if (data.playerId) {
          this.broadcast.sendToPlayer(data.playerId, "questCompleted", {
            questId: data.questId,
            questName: data.questName,
            rewards: data.rewards,
          });
        }
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up quest events:", _err);
    }
  }

  private sendResourceEvent(
    packetName: "resourceDepleted" | "resourceRespawned" | "resourceSpawned",
    payload: unknown,
  ): void {
    const resourceEvent = payload as {
      position?: { x: number; y: number; z: number };
    };
    const position = resourceEvent.position;

    if (
      position &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.z)
    ) {
      this.broadcast.sendToNearby(packetName, payload, position.x, position.z);
      return;
    }

    this.broadcast.sendToAll(packetName, payload);
  }

  private sendGatheringToolEvent(
    packetName: "gatheringToolShow" | "gatheringToolHide",
    payload: EventMap[
      EventType.GATHERING_TOOL_SHOW | EventType.GATHERING_TOOL_HIDE],
  ): void {
    const entity = this.world.entities.get(payload.playerId) as
      { position?: { x: number; z: number } } | undefined;
    const position = entity?.position;

    if (
      position &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.z)
    ) {
      this.broadcast.sendToNearby(packetName, payload, position.x, position.z);
      return;
    }

    // Cleanup can run after the entity leaves the spatial index. Preserve the
    // transition for its controlling client and the generic streaming client.
    this.broadcast.sendToPlayer(payload.playerId, packetName, payload);
    this.broadcast.sendToSpectators(packetName, payload);
  }

  private sendGatheringPresentationEvent(
    packetName:
      "fishingInteractionPresentation" | "processingInteractionPresentation",
    payload: EventMap[
      | EventType.FISHING_INTERACTION_PRESENTATION
      | EventType.PROCESSING_INTERACTION_PRESENTATION],
  ): void {
    const entity = this.world.entities.get(payload.playerId) as
      { position?: { x: number; z: number } } | undefined;
    const position = entity?.position;

    if (
      position &&
      Number.isFinite(position.x) &&
      Number.isFinite(position.z)
    ) {
      this.broadcast.sendToNearby(packetName, payload, position.x, position.z);
      return;
    }

    this.broadcast.sendToPlayer(payload.playerId, packetName, payload);
    this.broadcast.sendToSpectators(packetName, payload);
  }

  /**
   * Setup trade event listeners
   *
   * Handles trade cancellation events from TradingSystem (disconnect, timeout, death).
   * When a trade is cancelled by the system (not by player action), we need to notify
   * the affected players via network packets.
   *
   * @private
   */
  private setupTradeEvents(): void {
    try {
      // Listen for trade cancellation events from TradingSystem
      // This handles: timeout, disconnect, player death
      this.on(EventType.TRADE_CANCELLED, (payload: unknown) => {
        const data = payload as EventMap[EventType.TRADE_CANCELLED];

        // Build user-friendly message based on reason
        const reasonMessages: Record<string, string> = {
          timeout: "Trade request timed out",
          disconnected: "Other player disconnected",
          player_died: "Trade cancelled - player died",
          cancelled: "Trade was cancelled",
          declined: "Trade request declined",
          invalid_items: "Trade cancelled - items changed",
          inventory_full: "Trade cancelled - inventory full",
          server_error: "Trade cancelled - server error",
        };
        const message = reasonMessages[data.reason] || "Trade cancelled";

        // Send to initiator if we have their player ID
        if (data.initiatorId) {
          this.broadcast.sendToPlayer(data.initiatorId, "tradeCancelled", {
            tradeId: data.tradeId,
            reason: data.reason,
            message,
          });
        }

        // Send to recipient if we have their player ID
        if (data.recipientId) {
          this.broadcast.sendToPlayer(data.recipientId, "tradeCancelled", {
            tradeId: data.tradeId,
            reason: data.reason,
            message,
          });
        }
      });
    } catch (_err) {
      console.error("[EventBridge] Error setting up trade events:", _err);
    }
  }
}
