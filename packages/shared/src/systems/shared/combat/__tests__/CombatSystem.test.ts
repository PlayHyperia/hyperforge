/**
 * CombatSystem Unit Tests
 *
 * Tests for the main combat system orchestrator:
 * - Combat initiation and state management
 * - Attack processing and damage calculation
 * - Combat timeout and auto-attack
 * - Anti-cheat integration
 * - Pool statistics
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CombatSystem } from "../CombatSystem";
import type { World } from "../../../../core/World";
import { AttackType } from "../../../../types/game/item-types";
import { COMBAT_CONSTANTS } from "../../../../constants/CombatConstants";
import { registerStreamingDuelDamageAuthority } from "../StreamingDuelDamageAuthority";
import type { StreamingDuelDamageObservationContext } from "../../../../types/game/streaming-duel-action-observation";

interface MockPlayerEntity {
  id: string;
  type: string;
  position: { x: number; y: number; z: number };
  health: number;
  stats: {
    attack: number;
    strength: number;
    defence: number;
    hitpoints: number;
  };
  data: {
    isLoading: boolean;
    stats: {
      attack: number;
      strength: number;
      defence: number;
      hitpoints: number;
    };
  };
  combat: { combatTarget: string | null };
  emote: string;
  base: {
    quaternion: {
      set: ReturnType<typeof vi.fn>;
      copy: ReturnType<typeof vi.fn>;
    };
  };
  node: {
    position: { x: number; y: number; z: number };
    quaternion: {
      set: ReturnType<typeof vi.fn>;
      copy: ReturnType<typeof vi.fn>;
    };
  };
  getPosition: () => { x: number; y: number; z: number };
  markNetworkDirty: ReturnType<typeof vi.fn>;
  takeDamage: ReturnType<typeof vi.fn>;
  getHealth: () => number;
  getComponent: (name: string) => unknown;
}

interface MockMobEntity {
  id: string;
  type: string;
  position: { x: number; y: number; z: number };
  health: number;
  stats: {
    attack: number;
    strength: number;
    defence: number;
    hitpoints: number;
  };
  node: {
    position: { x: number; y: number; z: number };
    quaternion: {
      set: ReturnType<typeof vi.fn>;
      copy: ReturnType<typeof vi.fn>;
    };
  };
  getPosition: () => { x: number; y: number; z: number };
  getMobData: () => {
    health: number;
    stats: {
      attack: number;
      strength: number;
      defence: number;
      hitpoints: number;
    };
    combatRange: number;
    attackSpeedTicks: number;
  };
  getHealth: () => number;
  takeDamage: ReturnType<typeof vi.fn>;
  isAttackable: () => boolean;
  setServerEmote: ReturnType<typeof vi.fn>;
  markNetworkDirty: ReturnType<typeof vi.fn>;
  isDead: () => boolean;
}

// Mock player entity
function createMockPlayer(
  id: string,
  health: number = 100,
  position = { x: 0, y: 0, z: 0 },
) {
  let currentHealth = health;
  return {
    id,
    type: "player",
    position,
    health: currentHealth,
    stats: {
      attack: 10,
      strength: 10,
      defence: 10,
      hitpoints: health,
    },
    data: {
      isLoading: false,
      stats: { attack: 10, strength: 10, defence: 10, hitpoints: health },
    },
    combat: {
      combatTarget: null,
    },
    emote: "idle",
    base: { quaternion: { set: vi.fn(), copy: vi.fn() } },
    node: {
      position,
      quaternion: { set: vi.fn(), copy: vi.fn() },
    },
    getPosition: () => position,
    markNetworkDirty: vi.fn(),
    takeDamage: vi.fn((amount: number) => {
      currentHealth -= amount;
      return currentHealth;
    }),
    getHealth: () => currentHealth,
    // CombatSystem.isEntityAlive needs getComponent("health")
    getComponent: (name: string) => {
      if (name === "health") {
        return {
          data: {
            current: currentHealth,
            isDead: currentHealth <= 0,
          },
        };
      }
      return null;
    },
  };
}

// Mock mob entity
// NOTE: Default position (1, 0, 0) is CARDINAL adjacent to player at (0, 0, 0)
// classic MMORPG melee range 1 requires cardinal adjacency (no diagonal attacks)
function createMockMob(
  id: string,
  health: number = 50,
  position = { x: 1, y: 0, z: 0 },
) {
  let currentHealth = health;
  return {
    id,
    type: "mob",
    position,
    health: currentHealth,
    stats: {
      attack: 5,
      strength: 5,
      defence: 5,
      hitpoints: health,
    },
    node: {
      position,
      quaternion: { set: vi.fn(), copy: vi.fn() },
    },
    getPosition: () => position,
    getMobData: () => ({
      health: currentHealth,
      stats: { attack: 5, strength: 5, defence: 5, hitpoints: health },
      combatRange: 1,
      attackSpeedTicks: 4,
    }),
    getHealth: () => currentHealth,
    takeDamage: vi.fn((amount: number) => {
      currentHealth -= amount;
      return currentHealth;
    }),
    isAttackable: () => true,
    setServerEmote: vi.fn(),
    markNetworkDirty: vi.fn(),
    // CombatSystem.isEntityAlive needs isDead()
    isDead: () => currentHealth <= 0,
  };
}

// Mock World
function createMockWorld(
  options: {
    players?: Map<string, MockPlayerEntity>;
    mobs?: Map<string, MockMobEntity>;
    currentTick?: number;
    isServer?: boolean;
    equipmentSystem?: {
      getPlayerEquipment: (playerId: string) => Record<string, unknown>;
      consumeArrowAtomic?: ReturnType<typeof vi.fn>;
      consumeArrowForProjectileAtomic?: ReturnType<typeof vi.fn>;
      completeArrowProjectileAtomic?: ReturnType<typeof vi.fn>;
      cancelArrowProjectileAtomic?: ReturnType<typeof vi.fn>;
    };
    inventorySystem?: {
      getInventory: (playerId: string) => {
        items: Array<{ itemId: string; quantity: number; slot: number }>;
      };
      debitItemsAtomic: ReturnType<typeof vi.fn>;
      stageProjectileRuneCostAtomic?: ReturnType<typeof vi.fn>;
      completeProjectileRuneCostAtomic?: ReturnType<typeof vi.fn>;
      cancelProjectileRuneCostAtomic?: ReturnType<typeof vi.fn>;
    };
    groundItemSystem?: {
      exposeCommittedDurableSource: ReturnType<typeof vi.fn>;
    };
  } = {},
) {
  const players = options.players || new Map<string, MockPlayerEntity>();
  const mobs = options.mobs || new Map<string, MockMobEntity>();
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();

  // CombatSystem.getEntity() expects:
  // - world.entities.players.get() for players
  // - world.entities.get() for mobs
  // NOTE: Use the mobs Map directly (not a copy) so test can add mobs after creation
  const entities = mobs as Map<string, MockMobEntity> & {
    players: Map<string, MockPlayerEntity>;
  };
  entities.players = players;

  return {
    isServer: options.isServer ?? true,
    currentTick: options.currentTick ?? 100,
    entities,
    network: {
      send: vi.fn(),
    },
    getPlayer: (id: string) => players.get(id),
    getSystem: (name: string) => {
      if (name === "entity-manager") {
        // Required by CombatSystem.init()
        return {
          getEntity: (id: string) => entities.get(id) || players.get(id),
        };
      }
      if (name === "equipment") {
        const equipment = options.equipmentSystem ?? {
          getPlayerEquipment: () => ({ weapon: null }),
        };
        return {
          completeArrowProjectileAtomic:
            "completeArrowProjectileAtomic" in equipment &&
            equipment.completeArrowProjectileAtomic
              ? equipment.completeArrowProjectileAtomic
              : vi.fn(async (handle: any) => ({
                  ok: true,
                  playerId: handle.playerId,
                  operationId: handle.operationId,
                  arrowId: handle.itemId,
                  changed: true,
                  replayed: false,
                  requestFingerprint: handle.requestFingerprint,
                  status: "fired",
                  recoveryDisposition: handle.recoveryDisposition,
                  recoverySource: null,
                })),
          cancelArrowProjectileAtomic:
            "cancelArrowProjectileAtomic" in equipment &&
            equipment.cancelArrowProjectileAtomic
              ? equipment.cancelArrowProjectileAtomic
              : vi.fn(async (handle: any) => ({
                  ok: true,
                  playerId: handle.playerId,
                  operationId: handle.operationId,
                  arrowId: handle.itemId,
                  changed: true,
                  replayed: false,
                  requestFingerprint: handle.requestFingerprint,
                  status: "cancelled",
                  recoveryDisposition: handle.recoveryDisposition,
                  recoverySource: null,
                })),
          ...equipment,
        };
      }
      if (name === "inventory") {
        const inventory = options.inventorySystem;
        if (!inventory) return undefined;
        return {
          stageProjectileRuneCostAtomic:
            inventory.stageProjectileRuneCostAtomic ??
            vi.fn(async (...args: unknown[]) => {
              const receipt = await inventory.debitItemsAtomic(...args);
              return receipt.ok
                ? {
                    ...receipt,
                    requestFingerprint: "c".repeat(64),
                    status: "pending",
                  }
                : receipt;
            }),
          completeProjectileRuneCostAtomic:
            inventory.completeProjectileRuneCostAtomic ??
            vi.fn(async (handle: any) => ({
              ok: true,
              playerId: handle.playerId,
              operationId: handle.operationId,
              changed: true,
              replayed: false,
              requestFingerprint: handle.requestFingerprint,
              requirements: handle.requirements,
              status: "fired",
            })),
          cancelProjectileRuneCostAtomic:
            inventory.cancelProjectileRuneCostAtomic ??
            vi.fn(async (handle: any) => ({
              ok: true,
              playerId: handle.playerId,
              operationId: handle.operationId,
              changed: true,
              replayed: false,
              requestFingerprint: handle.requestFingerprint,
              requirements: handle.requirements,
              status: "cancelled",
            })),
          ...inventory,
        };
      }
      if (name === "ground-items") {
        return options.groundItemSystem;
      }
      if (name === "player") {
        return {
          damagePlayer: vi.fn(),
          getPlayer: (id: string) => players.get(id),
          // Critical: Return auto-retaliate setting (default true)
          getPlayerAutoRetaliate: () => true,
        };
      }
      if (name === "mob-npc") {
        return {
          getMob: (id: string) => mobs.get(id),
        };
      }
      return undefined;
    },
    on: (event: string, handler: Function) => {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, []);
      }
      eventHandlers.get(event)!.push(handler);
    },
    off: vi.fn(),
    emit: vi.fn((event: string, data: unknown) => {
      const handlers = eventHandlers.get(event) || [];
      handlers.forEach((h) => h(data));
    }),
    getEventHandlers: () => eventHandlers,
  };
}

describe("CombatSystem", () => {
  let combatSystem: CombatSystem;
  let mockWorld: ReturnType<typeof createMockWorld>;
  let mockPlayers: Map<string, MockPlayerEntity>;
  let mockMobs: Map<string, MockMobEntity>;

  beforeEach(async () => {
    mockPlayers = new Map();
    mockMobs = new Map();
    mockWorld = createMockWorld({
      players: mockPlayers,
      mobs: mockMobs,
      currentTick: 100,
    });

    combatSystem = new CombatSystem(mockWorld as unknown as World);
    // CRITICAL: Call init() to cache playerSystem for auto-retaliate checks
    await combatSystem.init();
  });

  afterEach(() => {
    combatSystem.destroy();
  });

  describe("constructor", () => {
    it("initializes with empty combat states", () => {
      expect(combatSystem.isInCombat("nonexistent")).toBe(false);
    });

    it("initializes anti-cheat system", () => {
      const stats = combatSystem.antiCheat.getStats();
      expect(stats.trackedPlayers).toBe(0);
    });

    it("initializes pool statistics", () => {
      const poolStats = combatSystem.getPoolStats();
      expect(poolStats.quaternions).toBeDefined();
      expect(poolStats.quaternions.total).toBeGreaterThan(0);
    });
  });

  describe("startCombat", () => {
    it("initiates combat between player and mob", () => {
      const player = createMockPlayer("player1");
      const mob = createMockMob("mob1");
      mockPlayers.set("player1", player);
      mockMobs.set("mob1", mob);

      const result = combatSystem.startCombat("player1", "mob1", {
        attackerType: "player",
        targetType: "mob",
      });

      expect(result).toBe(true);
      expect(combatSystem.isInCombat("player1")).toBe(true);
    });

    it("returns false for nonexistent attacker", () => {
      const mob = createMockMob("mob1");
      mockMobs.set("mob1", mob);

      const result = combatSystem.startCombat("nonexistent", "mob1", {
        attackerType: "player",
        targetType: "mob",
      });

      expect(result).toBe(false);
    });

    it("returns false for nonexistent target", () => {
      const player = createMockPlayer("player1");
      mockPlayers.set("player1", player);

      const result = combatSystem.startCombat("player1", "nonexistent", {
        attackerType: "player",
        targetType: "mob",
      });

      expect(result).toBe(false);
    });

    it("returns false when target is out of range", () => {
      const player = createMockPlayer("player1", 100, { x: 0, y: 0, z: 0 });
      const mob = createMockMob("mob1", 50, { x: 100, y: 0, z: 100 }); // Far away
      mockPlayers.set("player1", player);
      mockMobs.set("mob1", mob);

      const result = combatSystem.startCombat("player1", "mob1", {
        attackerType: "player",
        targetType: "mob",
      });

      expect(result).toBe(false);
    });

    it("returns false when target is dead", () => {
      const player = createMockPlayer("player1");
      const mob = createMockMob("mob1", 0); // Dead mob
      mockPlayers.set("player1", player);
      mockMobs.set("mob1", mob);

      const result = combatSystem.startCombat("player1", "mob1", {
        attackerType: "player",
        targetType: "mob",
      });

      expect(result).toBe(false);
    });
  });

  describe("isInCombat", () => {
    it("returns false for entity not in combat", () => {
      expect(combatSystem.isInCombat("player1")).toBe(false);
    });

    it("returns true for entity in combat", () => {
      const player = createMockPlayer("player1");
      const mob = createMockMob("mob1");
      mockPlayers.set("player1", player);
      mockMobs.set("mob1", mob);

      combatSystem.startCombat("player1", "mob1", {
        attackerType: "player",
        targetType: "mob",
      });

      expect(combatSystem.isInCombat("player1")).toBe(true);
    });
  });

  describe("getCombatData", () => {
    it("returns null for entity not in combat", () => {
      expect(combatSystem.getCombatData("player1")).toBeNull();
    });

    it("returns combat data for entity in combat", () => {
      const player = createMockPlayer("player1");
      const mob = createMockMob("mob1");
      mockPlayers.set("player1", player);
      mockMobs.set("mob1", mob);

      combatSystem.startCombat("player1", "mob1", {
        attackerType: "player",
        targetType: "mob",
      });

      const data = combatSystem.getCombatData("player1");
      expect(data).not.toBeNull();
      expect(data?.targetId).toBe("mob1");
    });
  });

  describe("forceEndCombat", () => {
    it("ends combat for entity", () => {
      const player = createMockPlayer("player1");
      const mob = createMockMob("mob1");
      mockPlayers.set("player1", player);
      mockMobs.set("mob1", mob);

      combatSystem.startCombat("player1", "mob1", {
        attackerType: "player",
        targetType: "mob",
      });
      expect(combatSystem.isInCombat("player1")).toBe(true);

      combatSystem.forceEndCombat("player1");
      expect(combatSystem.isInCombat("player1")).toBe(false);
    });

    it("cancels delayed damage for both combatants before state teardown", () => {
      const player = createMockPlayer("player1");
      const mob = createMockMob("mob1", 50, { x: 1, y: 0, z: 0 });
      mockPlayers.set("player1", player);
      mockMobs.set("mob1", mob);

      combatSystem.startCombat("player1", "mob1", {
        attackerType: "player",
        targetType: "mob",
      });

      const projectileService = (
        combatSystem as unknown as {
          projectileService: {
            createProjectile: (params: {
              sourceId: string;
              targetId: string;
              attackType: AttackType;
              damage: number;
              currentTick: number;
              sourcePosition: { x: number; z: number };
              targetPosition: { x: number; z: number };
            }) => { id: string } | null;
            getActiveCount: () => number;
            processTick: (tick: number) => { hits: unknown[] };
          };
        }
      ).projectileService;

      const outgoing = projectileService.createProjectile({
        sourceId: "player1",
        targetId: "mob1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });
      const incoming = projectileService.createProjectile({
        sourceId: "mob1",
        targetId: "player1",
        attackType: AttackType.MAGIC,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 5, z: 0 },
        targetPosition: { x: 0, z: 0 },
      });
      expect(projectileService.getActiveCount()).toBe(2);
      const cancellationSpy = vi.spyOn(
        combatSystem as unknown as {
          emitProjectileCancelled: (
            projectile: {
              id: string;
              attackerId: string;
              targetId: string;
              spellId?: string;
            },
            reason: string,
          ) => void;
        },
        "emitProjectileCancelled",
      );

      combatSystem.forceEndCombat("player1");

      expect(projectileService.getActiveCount()).toBe(0);
      expect(projectileService.processTick(1_000).hits).toHaveLength(0);
      expect(
        cancellationSpy.mock.calls.map(([projectile, reason]) => ({
          projectileId: projectile.id,
          attackerId: projectile.attackerId,
          targetId: projectile.targetId,
          projectileType: projectile.spellId ? "spell" : "arrow",
          reason,
        })),
      ).toEqual([
        expect.objectContaining({
          projectileId: outgoing?.id,
          attackerId: "player1",
          targetId: "mob1",
          projectileType: "arrow",
          reason: "combat_ended",
        }),
        expect.objectContaining({
          projectileId: incoming?.id,
          attackerId: "mob1",
          targetId: "player1",
          projectileType: "arrow",
          reason: "combat_ended",
        }),
      ]);
    });

    it("handles ending combat for entity not in combat", () => {
      expect(() => {
        combatSystem.forceEndCombat("nonexistent", "player");
      }).not.toThrow();
    });
  });

  describe("duel preparation combat fence", () => {
    it("blocks direct combat admission until the exact preparation releases it", async () => {
      const player = createMockPlayer("player1");
      const mob = createMockMob("mob1");
      mockPlayers.set("player1", player);
      mockMobs.set("mob1", mob);

      expect(
        combatSystem.beginDuelPreparationCombatFence(
          "player1",
          "preparation-a",
        ),
      ).toBe(true);
      expect(
        combatSystem.beginDuelPreparationCombatFence(
          "player1",
          "preparation-a",
        ),
      ).toBe(true);
      expect(
        combatSystem.beginDuelPreparationCombatFence(
          "player1",
          "preparation-b",
        ),
      ).toBe(false);
      expect(
        combatSystem.startCombat("player1", "mob1", {
          attackerType: "player",
          targetType: "mob",
        }),
      ).toBe(false);
      expect(combatSystem.isInCombat("player1")).toBe(false);
      await (
        combatSystem as unknown as {
          handleMeleeAttack: (data: {
            attackerId: string;
            targetId: string;
            attackerType: "player";
            targetType: "mob";
          }) => Promise<void>;
        }
      ).handleMeleeAttack({
        attackerId: "player1",
        targetId: "mob1",
        attackerType: "player",
        targetType: "mob",
      });
      expect(player.takeDamage).not.toHaveBeenCalled();
      expect(mob.takeDamage).not.toHaveBeenCalled();
      expect(combatSystem.isInCombat("player1")).toBe(false);

      expect(
        combatSystem.endDuelPreparationCombatFence("player1", "preparation-b"),
      ).toBe(false);
      expect(
        combatSystem.endDuelPreparationCombatFence("player1", "preparation-a"),
      ).toBe(true);
      expect(
        combatSystem.startCombat("player1", "mob1", {
          attackerType: "player",
          targetType: "mob",
        }),
      ).toBe(true);
      expect(combatSystem.isInCombat("player1")).toBe(true);
    });

    it("rejects malformed entity identities without throwing", () => {
      expect(
        combatSystem.beginDuelPreparationCombatFence(
          "invalid entity id",
          "preparation-a",
        ),
      ).toBe(false);
      expect(
        combatSystem.endDuelPreparationCombatFence(
          "invalid entity id",
          "preparation-a",
        ),
      ).toBe(false);
    });
  });

  describe("cleanupPlayerDisconnect", () => {
    it("cleans up combat state on disconnect", () => {
      const player = createMockPlayer("player1");
      const mob = createMockMob("mob1");
      mockPlayers.set("player1", player);
      mockMobs.set("mob1", mob);

      combatSystem.startCombat("player1", "mob1", {
        attackerType: "player",
        targetType: "mob",
      });

      combatSystem.cleanupPlayerDisconnect("player1");

      expect(combatSystem.isInCombat("player1")).toBe(false);
    });

    it("cleans up anti-cheat tracking on disconnect", () => {
      // Record a violation first
      const _antiCheatStats = combatSystem.antiCheat.getStats();
      // The cleanup should work even with no violations
      expect(() => {
        combatSystem.cleanupPlayerDisconnect("player1");
      }).not.toThrow();
    });
  });

  describe("anti-cheat integration", () => {
    it("antiCheat.getStats returns stats", () => {
      const stats = combatSystem.antiCheat.getStats();

      expect(stats).toHaveProperty("trackedPlayers");
      expect(stats).toHaveProperty("playersAboveWarning");
      expect(stats).toHaveProperty("playersAboveAlert");
      expect(stats).toHaveProperty("totalViolationsLast5Min");
    });

    it("antiCheat.getPlayerReport returns report", () => {
      const report = combatSystem.antiCheat.getPlayerReport("player1");

      expect(report).toHaveProperty("score");
      expect(report).toHaveProperty("recentViolations");
      expect(report).toHaveProperty("attacksThisTick");
    });

    it("antiCheat.getPlayersRequiringReview returns array", () => {
      const players = combatSystem.antiCheat.getPlayersRequiringReview();
      expect(Array.isArray(players)).toBe(true);
    });

    it("decayAntiCheatScores does not throw", () => {
      expect(() => {
        combatSystem.decayAntiCheatScores();
      }).not.toThrow();
    });

    it("antiCheat.getConfig returns configuration", () => {
      const config = combatSystem.antiCheat.getConfig();

      expect(config).toHaveProperty("warningThreshold");
      expect(config).toHaveProperty("alertThreshold");
      expect(config).toHaveProperty("scoreDecayPerMinute");
      expect(config).toHaveProperty("maxAttacksPerTick");
      expect(config.warningThreshold).toBe(25);
      expect(config.alertThreshold).toBe(35);
    });
  });

  describe("pool statistics", () => {
    it("getPoolStats returns quaternion pool stats", () => {
      const stats = combatSystem.getPoolStats();

      expect(stats.quaternions).toBeDefined();
      expect(stats.quaternions).toHaveProperty("total");
      expect(stats.quaternions).toHaveProperty("available");
      expect(stats.quaternions).toHaveProperty("inUse");
    });

    it("pool stats show correct structure", () => {
      const stats = combatSystem.getPoolStats();

      expect(typeof stats.quaternions.total).toBe("number");
      expect(typeof stats.quaternions.available).toBe("number");
      expect(typeof stats.quaternions.inUse).toBe("number");
      expect(stats.quaternions.total).toBeGreaterThanOrEqual(
        stats.quaternions.available,
      );
    });
  });

  describe("processCombatTick", () => {
    it("processes combat tick without errors", () => {
      expect(() => {
        combatSystem.processCombatTick(100);
      }).not.toThrow();
    });

    it("processes auto-attacks for entities in combat", () => {
      const player = createMockPlayer("player1");
      const mob = createMockMob("mob1");
      mockPlayers.set("player1", player);
      mockMobs.set("mob1", mob);

      combatSystem.startCombat("player1", "mob1", {
        attackerType: "player",
        targetType: "mob",
      });

      // Advance tick past attack cooldown
      mockWorld.currentTick = 110;

      expect(() => {
        combatSystem.processCombatTick(110);
      }).not.toThrow();
    });

    it("terminates a same-tick projectile when an earlier hit kills its target", () => {
      const mob = createMockMob("mob1", 5, { x: 5, y: 0, z: 0 });
      const attacker1 = createMockMob("attacker1", 10, {
        x: 0,
        y: 0,
        z: 0,
      });
      const attacker2 = createMockMob("attacker2", 10, {
        x: 0,
        y: 0,
        z: 0,
      });
      mockMobs.set(mob.id, mob);
      mockMobs.set(attacker1.id, attacker1);
      mockMobs.set(attacker2.id, attacker2);

      const projectileService = (
        combatSystem as unknown as {
          projectileService: {
            createProjectile: (params: {
              sourceId: string;
              targetId: string;
              attackType: AttackType;
              damage: number;
              currentTick: number;
              sourcePosition: { x: number; z: number };
              targetPosition: { x: number; z: number };
            }) => { id: string; hitsAtTick: number } | null;
          };
        }
      ).projectileService;
      const killingProjectile = projectileService.createProjectile({
        sourceId: "attacker1",
        targetId: mob.id,
        attackType: AttackType.RANGED,
        damage: 5,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });
      const supersededProjectile = projectileService.createProjectile({
        sourceId: "attacker2",
        targetId: mob.id,
        attackType: AttackType.RANGED,
        damage: 5,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      expect(killingProjectile).not.toBeNull();
      expect(supersededProjectile).not.toBeNull();
      const eventSpies = combatSystem as unknown as {
        emitProjectileHit: (
          attackerId: string,
          targetId: string,
          damage: number,
          projectileType: string,
          projectileId?: string,
        ) => void;
        emitProjectileCancelled: (
          projectile: {
            id: string;
            attackerId: string;
            targetId: string;
            spellId?: string;
          },
          reason: string,
        ) => void;
      };
      const hitSpy = vi.spyOn(eventSpies, "emitProjectileHit");
      const cancellationSpy = vi.spyOn(eventSpies, "emitProjectileCancelled");
      combatSystem.processCombatTick(killingProjectile!.hitsAtTick);

      expect(hitSpy).toHaveBeenCalledTimes(1);
      expect(hitSpy).toHaveBeenCalledWith(
        "attacker1",
        mob.id,
        5,
        "arrow",
        killingProjectile!.id,
      );
      expect(cancellationSpy).toHaveBeenCalledTimes(1);
      expect(cancellationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: supersededProjectile!.id,
          attackerId: "attacker2",
          targetId: mob.id,
        }),
        "entity_died",
      );
    });

    it("emits an exact terminal event when the projectile lifetime hard-stop wins", () => {
      const projectileService = (
        combatSystem as unknown as {
          projectileService: {
            createProjectile: (params: {
              sourceId: string;
              targetId: string;
              attackType: AttackType;
              damage: number;
              currentTick: number;
              sourcePosition: { x: number; z: number };
              targetPosition: { x: number; z: number };
            }) => { id: string; hitsAtTick: number } | null;
          };
        }
      ).projectileService;
      const projectile = projectileService.createProjectile({
        sourceId: "attacker1",
        targetId: "mob1",
        attackType: AttackType.RANGED,
        damage: 5,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });
      expect(projectile).not.toBeNull();
      projectile!.hitsAtTick = Number.POSITIVE_INFINITY;

      const cancellationSpy = vi.spyOn(
        combatSystem as unknown as {
          emitProjectileCancelled: (
            projectile: {
              id: string;
              attackerId: string;
              targetId: string;
              spellId?: string;
            },
            reason: string,
          ) => void;
        },
        "emitProjectileCancelled",
      );

      combatSystem.processCombatTick(121);

      expect(cancellationSpy).toHaveBeenCalledOnce();
      expect(cancellationSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: projectile!.id }),
        "projectile_expired",
      );
    });
  });

  describe("competitive projectile supply conservation", () => {
    it("debits one equipped arrow when a player launches a ranged projectile", async () => {
      const player = createMockPlayer("player-ranged", 100, {
        x: 0,
        y: 0,
        z: 0,
      });
      player.data.skills = {
        ranged: { level: 10, xp: 0 },
      } as never;
      const mob = createMockMob("mob-ranged", 50, { x: 0, y: 0, z: 3 });
      const players = new Map([[player.id, player]]);
      const mobs = new Map([[mob.id, mob]]);
      const consumeArrowAtomic = vi.fn(
        async (playerId: string, operationId: string, arrowId: string) => ({
          ok: true,
          playerId,
          operationId,
          arrowId,
          changed: true,
          replayed: false,
        }),
      );
      const rangedWorld = createMockWorld({
        players,
        mobs,
        equipmentSystem: {
          getPlayerEquipment: () => ({
            weapon: {
              itemId: "shortbow",
              item: {
                id: "shortbow",
                type: "weapon",
                weaponType: "BOW",
                attackType: "RANGED",
                attackRange: 7,
                attackSpeed: 4,
              },
            },
            arrows: {
              itemId: "bronze_arrow",
              item: { id: "bronze_arrow", type: "ammunition" },
              quantity: 2,
            },
          }),
          consumeArrowAtomic,
          consumeArrowForProjectileAtomic: consumeArrowAtomic,
        },
      });
      const rangedCombat = new CombatSystem(rangedWorld as unknown as World);
      await rangedCombat.init();
      const launchSpy = vi.spyOn(
        rangedCombat as unknown as {
          emitProjectileLaunched: (...args: unknown[]) => void;
        },
        "emitProjectileLaunched",
      );

      try {
        await (
          rangedCombat as unknown as {
            handleRangedAttack: (input: {
              attackerId: string;
              targetId: string;
              attackerType: "player";
              targetType: "mob";
            }) => Promise<void>;
          }
        ).handleRangedAttack({
          attackerId: player.id,
          targetId: mob.id,
          attackerType: "player",
          targetType: "mob",
        });

        expect(consumeArrowAtomic).toHaveBeenCalledOnce();
        expect(consumeArrowAtomic).toHaveBeenCalledWith(
          player.id,
          expect.stringMatching(/^ammunition-shot:[A-Za-z0-9]{20}$/),
          "bronze_arrow",
          expect.stringMatching(/^(recovered|destroyed)$/),
          expect.toSatisfy(
            (value: unknown) =>
              value === null ||
              (typeof value === "object" &&
                value !== null &&
                "x" in value &&
                "y" in value &&
                "z" in value),
          ),
        );
        expect(
          (
            rangedCombat as unknown as {
              projectileService: { getActiveCount: () => number };
            }
          ).projectileService.getActiveCount(),
        ).toBe(1);
        expect(launchSpy).toHaveBeenCalledOnce();
        expect(launchSpy.mock.calls[0]?.[7]).toBe(
          COMBAT_CONSTANTS.ARROW_LAUNCH_DELAY_MS,
        );
        expect(launchSpy.mock.calls[0]?.[8]).toBe(800);
      } finally {
        rangedCombat.destroy();
      }
    });

    it("exposes only the exact recovery receipt carried by an authoritative projectile hit", async () => {
      const player = createMockPlayer("player-ranged-recovery", 100, {
        x: 0,
        y: 0,
        z: 0,
      });
      player.data.skills = { ranged: { level: 10, xp: 0 } } as never;
      const mob = createMockMob("mob-ranged-recovery", 50, {
        x: 0,
        y: 0,
        z: 3,
      });
      const recoverySource = {
        sourceId: "ground_item_22222222-2222-4222-8222-222222222222",
        status: "active" as const,
        itemId: "bronze_arrow",
        quantity: 1,
        stackable: true,
        position: { x: 0.5, y: 0, z: 3.5 },
        tile: { x: 0, z: 3 },
        droppedBy: player.id,
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 121_000,
        lootProtectionExpiresAt: null,
        version: 1,
        contributionId:
          "ground-item-source:11111111-1111-4111-8111-111111111111",
        requestFingerprint: "a".repeat(64),
        replayed: false,
      };
      const consumeArrowForProjectileAtomic = vi.fn(
        async (playerId: string, operationId: string, arrowId: string) => ({
          ok: true as const,
          playerId,
          operationId,
          arrowId,
          changed: true as const,
          replayed: false,
          requestFingerprint: "b".repeat(64),
          status: "pending" as const,
          recoveryDisposition: "recovered" as const,
          recoverySource: null,
        }),
      );
      const completeArrowProjectileAtomic = vi.fn(async (handle: any) => ({
        ok: true as const,
        playerId: handle.playerId,
        operationId: handle.operationId,
        arrowId: handle.itemId,
        changed: true as const,
        replayed: false,
        requestFingerprint: handle.requestFingerprint,
        status: "fired" as const,
        recoveryDisposition: handle.recoveryDisposition,
        recoverySource,
      }));
      const cancelArrowProjectileAtomic = vi.fn(async (handle: any) => ({
        ok: true as const,
        playerId: handle.playerId,
        operationId: handle.operationId,
        arrowId: handle.itemId,
        changed: true as const,
        replayed: false,
        requestFingerprint: handle.requestFingerprint,
        status: "resolved" as const,
        recoveryDisposition: handle.recoveryDisposition,
        recoverySource,
      }));
      const exposeCommittedDurableSource = vi.fn(async () => true);
      const rangedWorld = createMockWorld({
        players: new Map([[player.id, player]]),
        mobs: new Map([[mob.id, mob]]),
        equipmentSystem: {
          getPlayerEquipment: () => ({
            weapon: {
              itemId: "shortbow",
              item: {
                id: "shortbow",
                type: "weapon",
                weaponType: "BOW",
                attackType: "RANGED",
                attackRange: 7,
                attackSpeed: 4,
              },
            },
            arrows: {
              itemId: "bronze_arrow",
              item: { id: "bronze_arrow", type: "ammunition" },
              quantity: 2,
            },
          }),
          consumeArrowForProjectileAtomic,
          completeArrowProjectileAtomic,
          cancelArrowProjectileAtomic,
        },
        groundItemSystem: { exposeCommittedDurableSource },
      });
      const rangedCombat = new CombatSystem(rangedWorld as unknown as World);
      await rangedCombat.init();
      const applyDamageSpy = vi
        .spyOn(
          rangedCombat as unknown as {
            applyDamage: (...args: unknown[]) => {
              success: boolean;
              actualDamage: number;
              targetDied: boolean;
            };
          },
          "applyDamage",
        )
        .mockReturnValue({ success: true, actualDamage: 0, targetDied: false });

      try {
        await (
          rangedCombat as unknown as {
            handleRangedAttack: (input: {
              attackerId: string;
              targetId: string;
              attackerType: "player";
              targetType: "mob";
            }) => Promise<void>;
          }
        ).handleRangedAttack({
          attackerId: player.id,
          targetId: mob.id,
          attackerType: "player",
          targetType: "mob",
        });
        expect(exposeCommittedDurableSource).not.toHaveBeenCalled();
        const projectile = (
          rangedCombat as unknown as {
            projectileService: {
              getProjectilesForTarget: (targetId: string) => Array<{
                hitsAtTick: number;
              }>;
            };
          }
        ).projectileService.getProjectilesForTarget(mob.id)[0];
        expect(projectile).toBeDefined();

        rangedCombat.processCombatTick(projectile!.hitsAtTick);
        expect(applyDamageSpy).toHaveBeenCalledWith(
          mob.id,
          "mob",
          expect.any(Number),
          player.id,
          {
            operationType: "ammunition_shot",
            operationId: consumeArrowForProjectileAtomic.mock.calls[0]![1],
            playerId: player.id,
            requestFingerprint: "b".repeat(64),
          },
        );
        await vi.waitFor(() =>
          expect(cancelArrowProjectileAtomic).toHaveBeenCalledOnce(),
        );
        await vi.waitFor(() =>
          expect(exposeCommittedDurableSource).toHaveBeenCalledWith(
            recoverySource,
          ),
        );
        expect(exposeCommittedDurableSource).toHaveBeenCalledOnce();
      } finally {
        rangedCombat.destroy();
      }
    });

    it("keeps one durable ranged commit in flight and timestamps launch at commit", async () => {
      const player = createMockPlayer("player-ranged-deferred", 100, {
        x: 0,
        y: 0,
        z: 0,
      });
      player.data.skills = { ranged: { level: 10, xp: 0 } } as never;
      const mob = createMockMob("mob-ranged-deferred", 50, {
        x: 0,
        y: 0,
        z: 3,
      });
      let resolveDebit!: (receipt: {
        ok: true;
        playerId: string;
        operationId: string;
        arrowId: string;
        changed: true;
        replayed: false;
      }) => void;
      const consumeArrowAtomic = vi.fn(
        (playerId: string, operationId: string, arrowId: string) =>
          new Promise<{
            ok: true;
            playerId: string;
            operationId: string;
            arrowId: string;
            changed: true;
            replayed: false;
          }>((resolve) => {
            resolveDebit = resolve;
          }),
      );
      const rangedWorld = createMockWorld({
        players: new Map([[player.id, player]]),
        mobs: new Map([[mob.id, mob]]),
        currentTick: 100,
        equipmentSystem: {
          getPlayerEquipment: () => ({
            weapon: {
              itemId: "shortbow",
              item: {
                id: "shortbow",
                type: "weapon",
                weaponType: "BOW",
                attackType: "RANGED",
                attackRange: 7,
                attackSpeed: 4,
              },
            },
            arrows: {
              itemId: "bronze_arrow",
              item: { id: "bronze_arrow", type: "ammunition" },
              quantity: 2,
            },
          }),
          consumeArrowAtomic,
          consumeArrowForProjectileAtomic: consumeArrowAtomic,
        },
      });
      const rangedCombat = new CombatSystem(rangedWorld as unknown as World);
      await rangedCombat.init();
      const attack = (
        rangedCombat as unknown as {
          handleRangedAttack: (input: {
            attackerId: string;
            targetId: string;
            attackerType: "player";
            targetType: "mob";
          }) => Promise<void>;
        }
      ).handleRangedAttack.bind(rangedCombat);

      try {
        const firstAttack = attack({
          attackerId: player.id,
          targetId: mob.id,
          attackerType: "player",
          targetType: "mob",
        });
        await vi.waitFor(() =>
          expect(consumeArrowAtomic).toHaveBeenCalledOnce(),
        );

        // Production movement continues while PostgreSQL owns the staged
        // debit. These mutable entity positions must not change the geometry
        // already bound into the projectile reservation.
        player.position.x = 1;
        mob.position.z = 4;

        (rangedWorld as { currentTick: number }).currentTick = 110;
        await attack({
          attackerId: player.id,
          targetId: mob.id,
          attackerType: "player",
          targetType: "mob",
        });
        expect(consumeArrowAtomic).toHaveBeenCalledOnce();

        resolveDebit({
          ok: true,
          playerId: player.id,
          operationId: consumeArrowAtomic.mock.calls[0]![1],
          arrowId: "bronze_arrow",
          changed: true,
          replayed: false,
        });
        await firstAttack;

        const internals = rangedCombat as unknown as {
          projectileService: {
            getProjectilesForTarget: (targetId: string) => Array<{
              firedAtTick: number;
            }>;
          };
          nextAttackTicks: Map<string, number>;
        };
        expect(
          internals.projectileService.getProjectilesForTarget(mob.id),
        ).toEqual([expect.objectContaining({ firedAtTick: 110 })]);
        expect(internals.nextAttackTicks.get(player.id)).toBe(114);
      } finally {
        rangedCombat.destroy();
      }
    });

    it("cannot launch a ranged projectile after combat ends during arrow custody", async () => {
      const player = createMockPlayer("player-ranged-terminal", 100, {
        x: 0,
        y: 0,
        z: 0,
      });
      player.data.skills = { ranged: { level: 10, xp: 0 } } as never;
      const mob = createMockMob("mob-ranged-terminal", 50, {
        x: 0,
        y: 0,
        z: 3,
      });
      let resolveDebit!: (receipt: {
        ok: true;
        playerId: string;
        operationId: string;
        arrowId: string;
        changed: true;
        replayed: false;
      }) => void;
      const consumeArrowAtomic = vi.fn(
        (playerId: string, operationId: string, arrowId: string) =>
          new Promise<{
            ok: true;
            playerId: string;
            operationId: string;
            arrowId: string;
            changed: true;
            replayed: false;
          }>((resolve) => {
            resolveDebit = resolve;
          }),
      );
      const rangedWorld = createMockWorld({
        players: new Map([[player.id, player]]),
        mobs: new Map([[mob.id, mob]]),
        currentTick: 100,
        equipmentSystem: {
          getPlayerEquipment: () => ({
            weapon: {
              itemId: "shortbow",
              item: {
                id: "shortbow",
                type: "weapon",
                weaponType: "BOW",
                attackType: "RANGED",
                attackRange: 7,
                attackSpeed: 4,
              },
            },
            arrows: {
              itemId: "bronze_arrow",
              item: { id: "bronze_arrow", type: "ammunition" },
              quantity: 2,
            },
          }),
          consumeArrowAtomic,
          consumeArrowForProjectileAtomic: consumeArrowAtomic,
        },
      });
      const rangedCombat = new CombatSystem(rangedWorld as unknown as World);
      await rangedCombat.init();
      const launchSpy = vi.spyOn(
        rangedCombat as unknown as {
          emitProjectileLaunched: (...args: unknown[]) => void;
        },
        "emitProjectileLaunched",
      );

      try {
        const attack = (
          rangedCombat as unknown as {
            handleRangedAttack: (input: {
              attackerId: string;
              targetId: string;
              attackerType: "player";
              targetType: "mob";
            }) => Promise<void>;
          }
        ).handleRangedAttack({
          attackerId: player.id,
          targetId: mob.id,
          attackerType: "player",
          targetType: "mob",
        });
        await vi.waitFor(() =>
          expect(consumeArrowAtomic).toHaveBeenCalledOnce(),
        );

        rangedCombat.startCombat(player.id, mob.id, {
          attackerType: "player",
          targetType: "mob",
        });
        rangedCombat.forceEndCombat(player.id);
        let custodySettled = false;
        const custodyBarrier = rangedCombat
          .waitForProjectileCustodySettlements()
          .then(() => {
            custodySettled = true;
          });
        await Promise.resolve();
        expect(custodySettled).toBe(false);
        resolveDebit({
          ok: true,
          playerId: player.id,
          operationId: consumeArrowAtomic.mock.calls[0]![1],
          arrowId: "bronze_arrow",
          changed: true,
          replayed: false,
        });
        await Promise.all([attack, custodyBarrier]);
        expect(custodySettled).toBe(true);

        const internals = rangedCombat as unknown as {
          projectileService: { getActiveCount: () => number };
          nextAttackTicks: Map<string, number>;
          attackCommitReferences: Map<string, number>;
          attackCommitEpochs: Map<string, number>;
        };
        expect(internals.projectileService.getActiveCount()).toBe(0);
        expect(internals.nextAttackTicks.has(player.id)).toBe(false);
        expect(internals.attackCommitReferences.size).toBe(0);
        expect(internals.attackCommitEpochs.size).toBe(0);
        expect(launchSpy).not.toHaveBeenCalled();
        expect(rangedCombat.isInCombat(player.id)).toBe(false);
      } finally {
        rangedCombat.destroy();
      }
    });

    it("cannot let a deferred ranged commit replace a newer combat target", async () => {
      const player = createMockPlayer("player-ranged-retarget", 100, {
        x: 0,
        y: 0,
        z: 0,
      });
      player.data.skills = { ranged: { level: 10, xp: 0 } } as never;
      const originalTarget = createMockMob("mob-ranged-original", 50, {
        x: 0,
        y: 0,
        z: 3,
      });
      const newerTarget = createMockMob("mob-ranged-newer", 50, {
        x: 0,
        y: 0,
        z: 1,
      });
      let resolveDebit!: (receipt: {
        ok: true;
        playerId: string;
        operationId: string;
        arrowId: string;
        changed: true;
        replayed: false;
      }) => void;
      const consumeArrowAtomic = vi.fn(
        (playerId: string, operationId: string, arrowId: string) =>
          new Promise<{
            ok: true;
            playerId: string;
            operationId: string;
            arrowId: string;
            changed: true;
            replayed: false;
          }>((resolve) => {
            resolveDebit = resolve;
          }),
      );
      const rangedWorld = createMockWorld({
        players: new Map([[player.id, player]]),
        mobs: new Map([
          [originalTarget.id, originalTarget],
          [newerTarget.id, newerTarget],
        ]),
        equipmentSystem: {
          getPlayerEquipment: () => ({
            weapon: {
              itemId: "shortbow",
              item: {
                id: "shortbow",
                type: "weapon",
                weaponType: "BOW",
                attackType: "RANGED",
                attackRange: 7,
                attackSpeed: 4,
              },
            },
            arrows: {
              itemId: "bronze_arrow",
              item: { id: "bronze_arrow", type: "ammunition" },
              quantity: 2,
            },
          }),
          consumeArrowAtomic,
          consumeArrowForProjectileAtomic: consumeArrowAtomic,
        },
      });
      const rangedCombat = new CombatSystem(rangedWorld as unknown as World);
      await rangedCombat.init();

      try {
        const attack = (
          rangedCombat as unknown as {
            handleRangedAttack: (input: {
              attackerId: string;
              targetId: string;
              attackerType: "player";
              targetType: "mob";
            }) => Promise<void>;
          }
        ).handleRangedAttack({
          attackerId: player.id,
          targetId: originalTarget.id,
          attackerType: "player",
          targetType: "mob",
        });
        await vi.waitFor(() =>
          expect(consumeArrowAtomic).toHaveBeenCalledOnce(),
        );

        expect(
          rangedCombat.startCombat(player.id, newerTarget.id, {
            attackerType: "player",
            targetType: "mob",
          }),
        ).toBe(true);
        resolveDebit({
          ok: true,
          playerId: player.id,
          operationId: consumeArrowAtomic.mock.calls[0]![1],
          arrowId: "bronze_arrow",
          changed: true,
          replayed: false,
        });
        await attack;

        const internals = rangedCombat as unknown as {
          projectileService: { getActiveCount: () => number };
          attackCommitReferences: Map<string, number>;
          attackCommitEpochs: Map<string, number>;
        };
        expect(internals.projectileService.getActiveCount()).toBe(0);
        expect(internals.attackCommitReferences.size).toBe(0);
        expect(internals.attackCommitEpochs.size).toBe(0);
        expect(rangedCombat.getCombatData(player.id)?.targetId).toBe(
          newerTarget.id,
        );
      } finally {
        rangedCombat.destroy();
      }
    });

    it("creates no ranged combat side effect when arrow custody fails", async () => {
      const player = createMockPlayer("player-ranged-failed", 100, {
        x: 0,
        y: 0,
        z: 0,
      });
      player.data.skills = { ranged: { level: 10, xp: 0 } } as never;
      const mob = createMockMob("mob-ranged-failed", 50, {
        x: 0,
        y: 0,
        z: 3,
      });
      const consumeArrowAtomic = vi.fn(async () => ({
        ok: false,
        playerId: player.id,
        operationId: "failed",
        arrowId: "bronze_arrow",
        changed: false,
        replayed: false,
        reason: "persistence_failed",
      }));
      const rangedWorld = createMockWorld({
        players: new Map([[player.id, player]]),
        mobs: new Map([[mob.id, mob]]),
        equipmentSystem: {
          getPlayerEquipment: () => ({
            weapon: {
              itemId: "shortbow",
              item: {
                id: "shortbow",
                type: "weapon",
                weaponType: "BOW",
                attackType: "RANGED",
                attackRange: 7,
                attackSpeed: 4,
              },
            },
            arrows: {
              itemId: "bronze_arrow",
              item: { id: "bronze_arrow", type: "ammunition" },
              quantity: 2,
            },
          }),
          consumeArrowAtomic,
          consumeArrowForProjectileAtomic: consumeArrowAtomic,
        },
      });
      const rangedCombat = new CombatSystem(rangedWorld as unknown as World);
      await rangedCombat.init();

      try {
        await (
          rangedCombat as unknown as {
            handleRangedAttack: (input: {
              attackerId: string;
              targetId: string;
              attackerType: "player";
              targetType: "mob";
            }) => Promise<void>;
          }
        ).handleRangedAttack({
          attackerId: player.id,
          targetId: mob.id,
          attackerType: "player",
          targetType: "mob",
        });

        const internals = rangedCombat as unknown as {
          projectileService: { getActiveCount: () => number };
          nextAttackTicks: Map<string, number>;
          attackCommitReferences: Map<string, number>;
          attackCommitEpochs: Map<string, number>;
        };
        expect(consumeArrowAtomic).toHaveBeenCalledOnce();
        expect(internals.projectileService.getActiveCount()).toBe(0);
        expect(internals.nextAttackTicks.has(player.id)).toBe(false);
        expect(internals.attackCommitReferences.size).toBe(0);
        expect(internals.attackCommitEpochs.size).toBe(0);
        expect(rangedCombat.isInCombat(player.id)).toBe(false);
        expect(player.emote).toBe("idle");
      } finally {
        rangedCombat.destroy();
      }
    });

    it("releases ranged commit authority when arrow custody throws", async () => {
      const player = createMockPlayer("player-ranged-throws", 100, {
        x: 0,
        y: 0,
        z: 0,
      });
      player.data.skills = { ranged: { level: 10, xp: 0 } } as never;
      const mob = createMockMob("mob-ranged-throws", 50, {
        x: 0,
        y: 0,
        z: 3,
      });
      const consumeArrowAtomic = vi.fn(async () => {
        throw new Error("arrow persistence unavailable");
      });
      const rangedWorld = createMockWorld({
        players: new Map([[player.id, player]]),
        mobs: new Map([[mob.id, mob]]),
        equipmentSystem: {
          getPlayerEquipment: () => ({
            weapon: {
              itemId: "shortbow",
              item: {
                id: "shortbow",
                type: "weapon",
                weaponType: "BOW",
                attackType: "RANGED",
                attackRange: 7,
                attackSpeed: 4,
              },
            },
            arrows: {
              itemId: "bronze_arrow",
              item: { id: "bronze_arrow", type: "ammunition" },
              quantity: 2,
            },
          }),
          consumeArrowAtomic,
          consumeArrowForProjectileAtomic: consumeArrowAtomic,
        },
      });
      const rangedCombat = new CombatSystem(rangedWorld as unknown as World);
      await rangedCombat.init();

      try {
        await expect(
          (
            rangedCombat as unknown as {
              handleRangedAttack: (input: {
                attackerId: string;
                targetId: string;
                attackerType: "player";
                targetType: "mob";
              }) => Promise<void>;
            }
          ).handleRangedAttack({
            attackerId: player.id,
            targetId: mob.id,
            attackerType: "player",
            targetType: "mob",
          }),
        ).resolves.toBeUndefined();

        const internals = rangedCombat as unknown as {
          projectileService: { getActiveCount: () => number };
          nextAttackTicks: Map<string, number>;
          pendingProjectileAttacks: Set<string>;
          attackCommitReferences: Map<string, number>;
          attackCommitEpochs: Map<string, number>;
        };
        expect(internals.projectileService.getActiveCount()).toBe(0);
        expect(internals.nextAttackTicks.has(player.id)).toBe(false);
        expect(internals.pendingProjectileAttacks.size).toBe(0);
        expect(internals.attackCommitReferences.size).toBe(0);
        expect(internals.attackCommitEpochs.size).toBe(0);
        expect(rangedCombat.isInCombat(player.id)).toBe(false);
      } finally {
        rangedCombat.destroy();
      }
    });

    it("debits every rune type for a selected contestant in one operation", async () => {
      const player = createMockPlayer("player-magic", 100, {
        x: 0,
        y: 0,
        z: 0,
      });
      player.data.skills = {
        magic: { level: 10, xp: 0 },
      } as never;
      player.data.inStreamingDuel = true as never;
      player.data.selectedSpell = "wind_strike" as never;
      const mob = createMockMob("mob-magic", 50, { x: 0, y: 0, z: 3 });
      const debitItemsAtomic = vi.fn(
        async (
          playerId: string,
          operationId: string,
          requirements: unknown[],
        ) => ({
          ok: true,
          playerId,
          operationId,
          changed: true,
          replayed: false,
          requirements,
        }),
      );
      const magicWorld = createMockWorld({
        players: new Map([[player.id, player]]),
        mobs: new Map([[mob.id, mob]]),
        equipmentSystem: {
          getPlayerEquipment: () => ({
            weapon: {
              itemId: "bronze_longsword",
              item: {
                id: "bronze_longsword",
                type: "weapon",
                weaponType: "LONGSWORD",
                attackType: "MELEE",
                attackRange: 1,
                attackSpeed: 5,
              },
            },
            arrows: null,
          }),
        },
        inventorySystem: {
          getInventory: () => ({
            items: [
              { itemId: "air_rune", quantity: 20, slot: 0 },
              { itemId: "mind_rune", quantity: 20, slot: 1 },
            ],
          }),
          debitItemsAtomic,
        },
      });
      const magicCombat = new CombatSystem(magicWorld as unknown as World);
      await magicCombat.init();
      const launchSpy = vi.spyOn(
        magicCombat as unknown as {
          emitProjectileLaunched: (...args: unknown[]) => void;
        },
        "emitProjectileLaunched",
      );

      try {
        await (
          magicCombat as unknown as {
            handleMagicAttack: (input: {
              attackerId: string;
              targetId: string;
              attackerType: "player";
              targetType: "mob";
            }) => Promise<void>;
          }
        ).handleMagicAttack({
          attackerId: player.id,
          targetId: mob.id,
          attackerType: "player",
          targetType: "mob",
        });

        expect(debitItemsAtomic).toHaveBeenCalledTimes(1);
        expect(debitItemsAtomic).toHaveBeenCalledWith(
          player.id,
          expect.stringMatching(/^spell-runes:[A-Za-z0-9]{20}$/),
          [
            { itemId: "air_rune", quantity: 1 },
            { itemId: "mind_rune", quantity: 1 },
          ],
        );
        expect(
          (
            magicCombat as unknown as {
              projectileService: { getActiveCount: () => number };
            }
          ).projectileService.getActiveCount(),
        ).toBe(1);
        expect(launchSpy).toHaveBeenCalledOnce();
        expect(launchSpy.mock.calls[0]?.[7]).toBe(
          COMBAT_CONSTANTS.SPELL_LAUNCH_DELAY_MS,
        );
        expect(launchSpy.mock.calls[0]?.[8]).toBe(600);
      } finally {
        magicCombat.destroy();
      }
    });

    it("cannot launch a spell after combat ends during rune custody", async () => {
      const player = createMockPlayer("player-magic-terminal", 100, {
        x: 0,
        y: 0,
        z: 0,
      });
      player.data.skills = { magic: { level: 10, xp: 0 } } as never;
      player.data.inStreamingDuel = true as never;
      player.data.selectedSpell = "wind_strike" as never;
      const mob = createMockMob("mob-magic-terminal", 50, {
        x: 0,
        y: 0,
        z: 3,
      });
      let resolveDebit!: (receipt: {
        ok: true;
        playerId: string;
        operationId: string;
        changed: true;
        replayed: false;
        requirements: Array<{ itemId: string; quantity: number }>;
      }) => void;
      const debitItemsAtomic = vi.fn(
        (
          playerId: string,
          operationId: string,
          requirements: Array<{ itemId: string; quantity: number }>,
        ) =>
          new Promise<{
            ok: true;
            playerId: string;
            operationId: string;
            changed: true;
            replayed: false;
            requirements: Array<{ itemId: string; quantity: number }>;
          }>((resolve) => {
            resolveDebit = resolve;
          }),
      );
      const cancelProjectileRuneCostAtomic = vi.fn(async (handle: any) => ({
        ok: true as const,
        playerId: handle.playerId,
        operationId: handle.operationId,
        changed: true as const,
        replayed: false,
        requestFingerprint: handle.requestFingerprint,
        requirements: handle.requirements,
        status: "cancelled" as const,
      }));
      const magicWorld = createMockWorld({
        players: new Map([[player.id, player]]),
        mobs: new Map([[mob.id, mob]]),
        currentTick: 100,
        equipmentSystem: {
          getPlayerEquipment: () => ({ weapon: null, arrows: null }),
        },
        inventorySystem: {
          getInventory: () => ({
            items: [
              { itemId: "air_rune", quantity: 20, slot: 0 },
              { itemId: "mind_rune", quantity: 20, slot: 1 },
            ],
          }),
          debitItemsAtomic,
          cancelProjectileRuneCostAtomic,
        },
      });
      const magicCombat = new CombatSystem(magicWorld as unknown as World);
      await magicCombat.init();
      const launchSpy = vi.spyOn(
        magicCombat as unknown as {
          emitProjectileLaunched: (...args: unknown[]) => void;
        },
        "emitProjectileLaunched",
      );

      try {
        const attack = (
          magicCombat as unknown as {
            handleMagicAttack: (input: {
              attackerId: string;
              targetId: string;
              attackerType: "player";
              targetType: "mob";
            }) => Promise<void>;
          }
        ).handleMagicAttack({
          attackerId: player.id,
          targetId: mob.id,
          attackerType: "player",
          targetType: "mob",
        });
        await vi.waitFor(() => expect(debitItemsAtomic).toHaveBeenCalledOnce());

        magicCombat.startCombat(player.id, mob.id, {
          attackerType: "player",
          targetType: "mob",
        });
        magicCombat.forceEndCombat(player.id);
        resolveDebit({
          ok: true,
          playerId: player.id,
          operationId: debitItemsAtomic.mock.calls[0]![1],
          changed: true,
          replayed: false,
          requirements: debitItemsAtomic.mock.calls[0]![2],
        });
        await attack;

        const internals = magicCombat as unknown as {
          projectileService: { getActiveCount: () => number };
          nextAttackTicks: Map<string, number>;
          attackCommitReferences: Map<string, number>;
          attackCommitEpochs: Map<string, number>;
        };
        expect(internals.projectileService.getActiveCount()).toBe(0);
        expect(internals.nextAttackTicks.has(player.id)).toBe(false);
        expect(internals.attackCommitReferences.size).toBe(0);
        expect(internals.attackCommitEpochs.size).toBe(0);
        expect(launchSpy).not.toHaveBeenCalled();
        expect(cancelProjectileRuneCostAtomic).toHaveBeenCalledOnce();
        expect(magicCombat.isInCombat(player.id)).toBe(false);
      } finally {
        magicCombat.destroy();
      }
    });

    it("creates no combat side effect when the atomic rune debit fails", async () => {
      const player = createMockPlayer("player-magic-failed", 100, {
        x: 0,
        y: 0,
        z: 0,
      });
      player.data.skills = { magic: { level: 10, xp: 0 } } as never;
      player.data.inStreamingDuel = true as never;
      player.data.selectedSpell = "wind_strike" as never;
      const mob = createMockMob("mob-magic-failed", 50, {
        x: 0,
        y: 0,
        z: 3,
      });
      const debitItemsAtomic = vi.fn(async () => ({
        ok: false,
        playerId: player.id,
        operationId: "failed",
        changed: false,
        replayed: false,
        requirements: [],
        reason: "persistence_failed",
      }));
      const magicWorld = createMockWorld({
        players: new Map([[player.id, player]]),
        mobs: new Map([[mob.id, mob]]),
        equipmentSystem: {
          getPlayerEquipment: () => ({ weapon: null, arrows: null }),
        },
        inventorySystem: {
          getInventory: () => ({
            items: [
              { itemId: "air_rune", quantity: 20, slot: 0 },
              { itemId: "mind_rune", quantity: 20, slot: 1 },
            ],
          }),
          debitItemsAtomic,
        },
      });
      const magicCombat = new CombatSystem(magicWorld as unknown as World);
      await magicCombat.init();

      try {
        await (
          magicCombat as unknown as {
            handleMagicAttack: (input: {
              attackerId: string;
              targetId: string;
              attackerType: "player";
              targetType: "mob";
            }) => Promise<void>;
          }
        ).handleMagicAttack({
          attackerId: player.id,
          targetId: mob.id,
          attackerType: "player",
          targetType: "mob",
        });

        const internals = magicCombat as unknown as {
          projectileService: { getActiveCount: () => number };
          nextAttackTicks: Map<string, number>;
          attackCommitReferences: Map<string, number>;
          attackCommitEpochs: Map<string, number>;
        };
        expect(debitItemsAtomic).toHaveBeenCalledOnce();
        expect(internals.projectileService.getActiveCount()).toBe(0);
        expect(internals.nextAttackTicks.has(player.id)).toBe(false);
        expect(internals.attackCommitReferences.size).toBe(0);
        expect(internals.attackCommitEpochs.size).toBe(0);
        expect(magicCombat.isInCombat(player.id)).toBe(false);
        expect(player.emote).toBe("idle");
      } finally {
        magicCombat.destroy();
      }
    });

    it("releases magic commit authority when rune custody throws", async () => {
      const player = createMockPlayer("player-magic-throws", 100, {
        x: 0,
        y: 0,
        z: 0,
      });
      player.data.skills = { magic: { level: 10, xp: 0 } } as never;
      player.data.inStreamingDuel = true as never;
      player.data.selectedSpell = "wind_strike" as never;
      const mob = createMockMob("mob-magic-throws", 50, {
        x: 0,
        y: 0,
        z: 3,
      });
      const debitItemsAtomic = vi.fn(async () => {
        throw new Error("rune persistence unavailable");
      });
      const magicWorld = createMockWorld({
        players: new Map([[player.id, player]]),
        mobs: new Map([[mob.id, mob]]),
        equipmentSystem: {
          getPlayerEquipment: () => ({ weapon: null, arrows: null }),
        },
        inventorySystem: {
          getInventory: () => ({
            items: [
              { itemId: "air_rune", quantity: 20, slot: 0 },
              { itemId: "mind_rune", quantity: 20, slot: 1 },
            ],
          }),
          debitItemsAtomic,
        },
      });
      const magicCombat = new CombatSystem(magicWorld as unknown as World);
      await magicCombat.init();

      try {
        await expect(
          (
            magicCombat as unknown as {
              handleMagicAttack: (input: {
                attackerId: string;
                targetId: string;
                attackerType: "player";
                targetType: "mob";
              }) => Promise<void>;
            }
          ).handleMagicAttack({
            attackerId: player.id,
            targetId: mob.id,
            attackerType: "player",
            targetType: "mob",
          }),
        ).resolves.toBeUndefined();

        const internals = magicCombat as unknown as {
          projectileService: { getActiveCount: () => number };
          nextAttackTicks: Map<string, number>;
          pendingProjectileAttacks: Set<string>;
          attackCommitReferences: Map<string, number>;
          attackCommitEpochs: Map<string, number>;
        };
        expect(internals.projectileService.getActiveCount()).toBe(0);
        expect(internals.nextAttackTicks.has(player.id)).toBe(false);
        expect(internals.pendingProjectileAttacks.size).toBe(0);
        expect(internals.attackCommitReferences.size).toBe(0);
        expect(internals.attackCommitEpochs.size).toBe(0);
        expect(magicCombat.isInCombat(player.id)).toBe(false);
      } finally {
        magicCombat.destroy();
      }
    });
  });

  describe("destroy", () => {
    it("cleans up all resources", () => {
      const player = createMockPlayer("player1");
      const mob = createMockMob("mob1");
      mockPlayers.set("player1", player);
      mockMobs.set("mob1", mob);

      combatSystem.startCombat("player1", "mob1", {
        attackerType: "player",
        targetType: "mob",
      });

      combatSystem.destroy();

      // After destroy, combat state should be cleared
      expect(combatSystem.isInCombat("player1")).toBe(false);
    });
  });

  describe("combat state service integration", () => {
    it("stateService is accessible", () => {
      expect(combatSystem.stateService).toBeDefined();
    });

    it("getAllCombatStates returns array", () => {
      const states = combatSystem.stateService.getAllCombatStates();
      expect(Array.isArray(states)).toBe(true);
    });

    it("tracks combat states correctly", () => {
      const player = createMockPlayer("player1");
      const mob = createMockMob("mob1");
      mockPlayers.set("player1", player);
      mockMobs.set("mob1", mob);

      combatSystem.startCombat("player1", "mob1", {
        attackerType: "player",
        targetType: "mob",
      });

      const states = combatSystem.stateService.getAllCombatStates();
      // classic MMORPG-style: Both attacker and target enter combat (mutual combat)
      expect(states.length).toBeGreaterThanOrEqual(1);
      // Verify player is in combat
      expect(combatSystem.isInCombat("player1")).toBe(true);
    });
  });
});

describe("CombatSystem streaming-duel damage reconciliation", () => {
  function createDamageFixture() {
    const attacker = {
      id: "agent-a",
      type: "player",
      data: { inStreamingDuel: true },
    };
    const target = {
      id: "agent-b",
      type: "player",
      data: { inStreamingDuel: true },
    };
    const players = new Map<string, any>([
      [attacker.id, attacker],
      [target.id, target],
    ]);
    const entities = players as Map<string, any> & {
      players: Map<string, any>;
    };
    entities.players = players;
    const damagePlayerAtomic = vi.fn();
    const playerSystem = {
      damagePlayerAtomic,
      getPlayer: (id: string) => players.get(id),
      getPlayerAutoRetaliate: () => true,
    };
    const world = {
      isServer: true,
      currentTick: 88,
      entities,
      network: { send: vi.fn() },
      getPlayer: (id: string) => players.get(id),
      getSystem: (name: string) => {
        if (name === "entity-manager") {
          return { getEntity: (id: string) => players.get(id) };
        }
        if (name === "player") return playerSystem;
        if (name === "equipment") {
          return { getPlayerEquipment: () => ({ weapon: null }) };
        }
        return undefined;
      },
    };
    const started = vi.fn();
    const settled = vi.fn();
    const failed = vi.fn();
    let sequence = 0;
    const contexts: StreamingDuelDamageObservationContext[] = [];
    const unregister = registerStreamingDuelDamageAuthority(world, {
      createDamageObservationContext: (attackerId, targetId, damage) => {
        sequence += 1;
        const context = {
          operationId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
          tick: 88,
          observedAt: 1_800_000_000_000 + sequence,
          cycleId: "cycle-reconcile",
          duelId: "duel-reconcile",
          actorId: attackerId,
          opponentId: targetId,
          phase: "FIGHTING" as const,
          combatRole: "ranged" as const,
          tacticalMacro: "kite" as const,
          requestedDamage: damage,
        } satisfies StreamingDuelDamageObservationContext;
        contexts.push(context);
        return { publicActionObservation: context };
      },
      handleDamageCommitStarted: started,
      handleDamageCommitSettled: settled,
      handleDamageCommitFailure: failed,
    });
    const combat = new CombatSystem(world as unknown as World);
    return {
      combat,
      world,
      damagePlayerAtomic,
      contexts,
      started,
      settled,
      failed,
      unregister,
    };
  }

  function successReceipt(
    context: StreamingDuelDamageObservationContext,
    replayed = false,
  ) {
    return {
      ok: true as const,
      committed: true as const,
      operationId: context.operationId,
      replayed,
      appliedDamage: context.requestedDamage,
      targetDied: false,
      publicActionObservation: context,
      competitiveTerminal: null,
    };
  }

  it("serializes later same-attacker hits instead of silently dropping them", async () => {
    const fixture = createDamageFixture();
    await fixture.combat.init();
    let releaseFirst: (() => void) | undefined;
    fixture.damagePlayerAtomic
      .mockImplementationOnce(
        async (...args: unknown[]) =>
          new Promise((resolve) => {
            releaseFirst = () =>
              resolve(
                successReceipt(
                  args[3] as StreamingDuelDamageObservationContext,
                ),
              );
          }),
      )
      .mockImplementationOnce(async (...args: unknown[]) =>
        successReceipt(args[3] as StreamingDuelDamageObservationContext),
      );

    try {
      const applyDamage = (
        fixture.combat as unknown as {
          applyDamage: (
            targetId: string,
            targetType: string,
            damage: number,
            attackerId: string,
          ) => Promise<unknown>;
        }
      ).applyDamage.bind(fixture.combat);
      const first = applyDamage("agent-b", "player", 4, "agent-a");
      const second = applyDamage("agent-b", "player", 3, "agent-a");
      await vi.waitFor(() =>
        expect(fixture.damagePlayerAtomic).toHaveBeenCalledTimes(1),
      );
      expect(fixture.combat.getDuelDamageReconciliationStats()).toMatchObject({
        pendingOperations: 2,
        queuedOperations: 1,
        committingOperations: 1,
        reconcilingOperations: 0,
        maxReconciliationAttempts: 0,
        oldestReconciliationAgeMs: 0,
      });
      expect(
        fixture.combat.getDuelDamageReconciliationStats().oldestPendingAgeMs,
      ).toBeGreaterThanOrEqual(0);

      releaseFirst?.();
      await expect(first).resolves.toMatchObject({
        success: true,
        actualDamage: 4,
      });
      await expect(second).resolves.toMatchObject({
        success: true,
        actualDamage: 3,
      });
      expect(fixture.damagePlayerAtomic).toHaveBeenCalledTimes(2);
      expect(fixture.started).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(fixture.settled).toHaveBeenCalledTimes(2));
      expect(fixture.failed).not.toHaveBeenCalled();
      expect(
        fixture.combat.getDuelDamageReconciliationStats().pendingOperations,
      ).toBe(0);
    } finally {
      fixture.unregister();
      fixture.combat.destroy();
    }
  });

  it("retries one exact unknown operation and exposes aggregate degraded state", async () => {
    vi.useFakeTimers();
    const fixture = createDamageFixture();
    await fixture.combat.init();
    fixture.damagePlayerAtomic
      .mockResolvedValueOnce({
        ok: false,
        committed: false,
        operationId: "00000000-0000-4000-8000-000000000001",
        replayed: false,
        appliedDamage: 0,
        targetDied: false,
        competitiveTerminal: null,
        reason: "persistence_unknown",
      })
      .mockImplementationOnce(async (...args: unknown[]) =>
        successReceipt(args[3] as StreamingDuelDamageObservationContext, true),
      );

    try {
      const result = (
        fixture.combat as unknown as {
          applyDamage: (
            targetId: string,
            targetType: string,
            damage: number,
            attackerId: string,
          ) => Promise<unknown>;
        }
      ).applyDamage("agent-b", "player", 5, "agent-a");
      await vi.waitFor(() =>
        expect(fixture.damagePlayerAtomic).toHaveBeenCalledOnce(),
      );
      expect(fixture.combat.getDuelDamageReconciliationStats()).toMatchObject({
        pendingOperations: 1,
        reconcilingOperations: 1,
        maxReconciliationAttempts: 1,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result).resolves.toMatchObject({
        success: true,
        actualDamage: 5,
      });
      expect(fixture.damagePlayerAtomic).toHaveBeenCalledTimes(2);
      expect(fixture.damagePlayerAtomic.mock.calls[0]![3]).toEqual(
        fixture.damagePlayerAtomic.mock.calls[1]![3],
      );
      expect(fixture.failed).not.toHaveBeenCalled();
    } finally {
      fixture.unregister();
      fixture.combat.destroy();
      vi.useRealTimers();
    }
  });

  it("stops authoring new duel attacks while persistence truth is unknown", async () => {
    vi.useFakeTimers();
    const fixture = createDamageFixture();
    await fixture.combat.init();
    fixture.damagePlayerAtomic.mockResolvedValue({
      ok: false,
      committed: false,
      operationId: "00000000-0000-4000-8000-000000000001",
      replayed: false,
      appliedDamage: 0,
      targetDied: false,
      competitiveTerminal: null,
      reason: "persistence_unknown",
    });
    const attackFailed = vi.spyOn(fixture.combat as any, "emitAttackFailed");

    try {
      const pending = (
        fixture.combat as unknown as {
          applyDamage: (
            targetId: string,
            targetType: string,
            damage: number,
            attackerId: string,
          ) => Promise<unknown>;
        }
      ).applyDamage("agent-b", "player", 5, "agent-a");
      await vi.waitFor(() =>
        expect(fixture.damagePlayerAtomic).toHaveBeenCalledOnce(),
      );

      await (
        fixture.combat as unknown as {
          handleAttack: (input: {
            attackerId: string;
            targetId: string;
            attackerType: "player";
            targetType: "player";
          }) => Promise<void>;
        }
      ).handleAttack({
        attackerId: "agent-a",
        targetId: "agent-b",
        attackerType: "player",
        targetType: "player",
      });
      expect(attackFailed).toHaveBeenCalledWith(
        "agent-a",
        "agent-b",
        "damage_persistence_reconciling",
      );
      expect(fixture.damagePlayerAtomic).toHaveBeenCalledOnce();

      fixture.combat.destroy();
      await expect(pending).resolves.toMatchObject({ success: false });
    } finally {
      fixture.unregister();
      fixture.combat.destroy();
      vi.useRealTimers();
    }
  });

  it("settles a retained retry wait during teardown without fabricating damage", async () => {
    vi.useFakeTimers();
    const fixture = createDamageFixture();
    await fixture.combat.init();
    fixture.damagePlayerAtomic.mockResolvedValue({
      ok: false,
      committed: false,
      operationId: "00000000-0000-4000-8000-000000000001",
      replayed: false,
      appliedDamage: 0,
      targetDied: false,
      competitiveTerminal: null,
      reason: "persistence_unknown",
    });

    try {
      const result = (
        fixture.combat as unknown as {
          applyDamage: (
            targetId: string,
            targetType: string,
            damage: number,
            attackerId: string,
          ) => Promise<unknown>;
        }
      ).applyDamage("agent-b", "player", 5, "agent-a");
      await vi.waitFor(() =>
        expect(fixture.damagePlayerAtomic).toHaveBeenCalledOnce(),
      );
      fixture.combat.destroy();
      await expect(result).resolves.toMatchObject({
        success: false,
        actualDamage: 0,
      });
      await vi.waitFor(() => expect(fixture.settled).toHaveBeenCalledOnce());
    } finally {
      fixture.unregister();
      fixture.combat.destroy();
      vi.useRealTimers();
    }
  });
});
