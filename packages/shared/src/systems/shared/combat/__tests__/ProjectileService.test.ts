/**
 * ProjectileService Unit Tests
 *
 * Tests projectile creation and hit timing:
 * - Create projectiles with hit delay
 * - Process hits on correct tick
 * - Cancel projectiles for target/attacker
 * - Track active projectiles
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ProjectileService } from "../ProjectileService";
import { AttackType } from "../../../../types/game/item-types";

describe("ProjectileService", () => {
  let service: ProjectileService;

  beforeEach(() => {
    service = new ProjectileService();
  });

  describe("createProjectile", () => {
    it("creates a projectile with correct properties", () => {
      const projectile = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
        arrowId: "bronze_arrow",
        xpReward: 15,
      });

      expect(projectile).toBeDefined();
      expect(projectile.attackerId).toBe("player-1");
      expect(projectile.targetId).toBe("mob-1");
      expect(projectile.damage).toBe(10);
      expect(projectile.arrowId).toBe("bronze_arrow");
      expect(projectile.xpReward).toBe(15);
      expect(projectile.cancelled).toBe(false);
      expect(projectile.processed).toBe(false);
    });

    it("creates magic projectile with spell ID", () => {
      const projectile = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.MAGIC,
        damage: 8,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
        spellId: "fire_strike",
        xpReward: 11.5,
      });

      expect(projectile.spellId).toBe("fire_strike");
      expect(projectile.arrowId).toBeUndefined();
    });

    it("assigns unique IDs even for the same pair committed on one tick", () => {
      const p1 = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      const p2 = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      expect(p1.id).not.toBe(p2.id);
      expect(service.getActiveCount()).toBe(2);
    });

    it("calculates hit tick based on distance and type", () => {
      // Close range (1 tile)
      const closeProjectile = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 1, z: 0 },
      });

      // Far range (10 tiles)
      const farProjectile = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-2",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 10, z: 0 },
      });

      // Far projectile should hit later
      expect(farProjectile.hitsAtTick).toBeGreaterThan(
        closeProjectile.hitsAtTick,
      );
    });

    it("increments active count", () => {
      expect(service.getActiveCount()).toBe(0);

      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      expect(service.getActiveCount()).toBe(1);

      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-2",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      expect(service.getActiveCount()).toBe(2);
    });
  });

  describe("projectile reservations", () => {
    const params = (targetId: string) => ({
      sourceId: "player-1",
      targetId,
      attackType: AttackType.RANGED,
      damage: 10,
      currentTick: 100,
      sourcePosition: { x: 0, z: 0 },
      targetPosition: { x: 5, z: 0 },
    });

    it("holds capacity across asynchronous admission and consumes it once", () => {
      const reservations = Array.from({ length: 10 }, () =>
        service.reserveProjectile("player-1", { x: 0, z: 0 }, { x: 5, z: 0 }),
      );

      expect(reservations.every(Boolean)).toBe(true);
      expect(
        service.reserveProjectile("player-1", { x: 0, z: 0 }, { x: 5, z: 0 }),
      ).toBeNull();
      expect(service.createProjectile(params("unreserved"))).toBeNull();

      const reservation = reservations[0]!;
      expect(
        service.createReservedProjectile(reservation, params("mob-1")),
      ).not.toBeNull();
      expect(
        service.createReservedProjectile(reservation, params("mob-2")),
      ).toBeNull();
      expect(service.getActiveCount()).toBe(1);
    });

    it("rejects mismatched geometry without consuming the lease", () => {
      const reservation = service.reserveProjectile(
        "player-1",
        { x: 0, z: 0 },
        { x: 5, z: 0 },
      )!;

      expect(
        service.createReservedProjectile(reservation, {
          ...params("mob-1"),
          targetPosition: { x: 6, z: 0 },
        }),
      ).toBeNull();
      expect(
        service.createReservedProjectile(reservation, params("mob-1")),
      ).not.toBeNull();
    });

    it("releases unused leases idempotently and clear drops every lease", () => {
      const first = service.reserveProjectile(
        "player-1",
        { x: 0, z: 0 },
        { x: 5, z: 0 },
      )!;
      expect(service.releaseProjectileReservation(first)).toBe(true);
      expect(service.releaseProjectileReservation(first)).toBe(false);

      const second = service.reserveProjectile(
        "player-1",
        { x: 0, z: 0 },
        { x: 5, z: 0 },
      )!;
      service.clear();
      expect(
        service.createReservedProjectile(second, params("mob-1")),
      ).toBeNull();
    });
  });

  describe("processTick", () => {
    it("returns empty hits before projectile hit tick", () => {
      const projectile = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      // Process before hit tick
      const result = service.processTick(projectile.hitsAtTick - 1);

      expect(result.hits).toHaveLength(0);
      expect(result.remaining).toBe(1);
    });

    it("returns projectile on hit tick", () => {
      const projectile = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      const result = service.processTick(projectile.hitsAtTick);

      expect(result.hits).toHaveLength(1);
      expect(result.hits[0].id).toBe(projectile.id);
      expect(result.hits[0].damage).toBe(10);
      expect(result.remaining).toBe(0);
    });

    it("removes projectile after processing", () => {
      const projectile = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      service.processTick(projectile.hitsAtTick);

      // Process again - should be empty
      const result = service.processTick(projectile.hitsAtTick + 1);
      expect(result.hits).toHaveLength(0);
      expect(result.remaining).toBe(0);
    });

    it("processes multiple projectiles hitting same tick", () => {
      // Create two projectiles at same distance
      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      service.createProjectile({
        sourceId: "player-2",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 15,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      // Both should hit around same tick
      const result = service.processTick(102);

      expect(result.hits).toHaveLength(2);
      expect(result.remaining).toBe(0);
    });

    it("does not process cancelled projectiles", () => {
      const projectile = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      service.cancelProjectilesForTarget("mob-1");

      const result = service.processTick(projectile.hitsAtTick);

      expect(result.hits).toHaveLength(0);
      expect(result.remaining).toBe(0);
    });

    it("returns an explicit terminal record when a projectile exceeds its lifetime", () => {
      const projectile = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      expect(projectile).not.toBeNull();
      projectile!.hitsAtTick = Number.POSITIVE_INFINITY;
      const result = service.processTick(121);

      expect(result.hits).toHaveLength(0);
      expect(result.expired).toEqual([
        expect.objectContaining({
          id: projectile!.id,
          attackerId: "player-1",
          targetId: "mob-1",
          cancelled: true,
        }),
      ]);
      expect(result.remaining).toBe(0);
    });
  });

  describe("cancelProjectilesForTarget", () => {
    it("cancels all projectiles for a target", () => {
      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      service.createProjectile({
        sourceId: "player-2",
        targetId: "mob-1",
        attackType: AttackType.MAGIC,
        damage: 8,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      const cancelled = service.cancelProjectilesForTarget("mob-1");

      expect(cancelled).toBe(2);
    });

    it("reports each exact projectile before removing it", () => {
      const projectile = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
        arrowId: "bronze_arrow",
      });
      const observed: string[] = [];

      service.cancelProjectilesForTarget("mob-1", (cancelled) => {
        observed.push(cancelled.id);
        expect(service.getProjectile(cancelled.id)).toBe(cancelled);
      });

      expect(observed).toEqual([projectile?.id]);
      expect(service.getProjectile(projectile!.id)).toBeUndefined();
    });

    it("returns 0 when no projectiles for target", () => {
      const cancelled = service.cancelProjectilesForTarget("mob-999");

      expect(cancelled).toBe(0);
    });

    it("does not cancel projectiles for other targets", () => {
      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-2",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      service.cancelProjectilesForTarget("mob-1");

      expect(service.getActiveCount()).toBe(1); // Cancelled projectile removed immediately
      expect(service.getProjectilesForTarget("mob-2")).toHaveLength(1);
    });
  });

  describe("cancelProjectile", () => {
    it("cancels only the exact identity and notifies before removal", () => {
      const first = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      })!;
      const second = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      })!;

      expect(
        service.cancelProjectile(first.id, (projectile) => {
          expect(projectile).toBe(first);
          expect(service.getProjectile(first.id)).toBe(first);
        }),
      ).toBe(true);
      expect(service.cancelProjectile(first.id)).toBe(false);
      expect(service.getProjectile(first.id)).toBeUndefined();
      expect(service.getProjectile(second.id)).toBe(second);
    });
  });

  describe("cancelProjectilesFromAttacker", () => {
    it("cancels all projectiles from an attacker", () => {
      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-2",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      const cancelled = service.cancelProjectilesFromAttacker("player-1");

      expect(cancelled).toBe(2);
    });

    it("does not cancel projectiles from other attackers", () => {
      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      service.createProjectile({
        sourceId: "player-2",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      service.cancelProjectilesFromAttacker("player-1");

      const remaining = service.getProjectilesForTarget("mob-1");
      expect(remaining).toHaveLength(1);
    });
  });

  describe("cancelProjectilesBetween", () => {
    it("cancels both directions for one pair without affecting third parties", () => {
      const create = (sourceId: string, targetId: string) =>
        service.createProjectile({
          sourceId,
          targetId,
          attackType: AttackType.RANGED,
          damage: 10,
          currentTick: 100,
          sourcePosition: { x: 0, z: 0 },
          targetPosition: { x: 5, z: 0 },
        });

      create("player-1", "player-2");
      create("player-2", "player-1");
      create("player-1", "player-3");
      create("player-4", "player-2");

      expect(service.cancelProjectilesBetween("player-1", "player-2")).toBe(2);
      expect(service.getActiveCount()).toBe(2);
      expect(service.getProjectilesForTarget("player-3")).toHaveLength(1);
      expect(service.getProjectilesForTarget("player-2")).toHaveLength(1);
    });
  });

  describe("hasActiveProjectilesBetween", () => {
    it("tracks either direction for only the exact unresolved pair", () => {
      service.createProjectile({
        sourceId: "player-2",
        targetId: "player-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 2, z: 0 },
      });
      service.createProjectile({
        sourceId: "player-1",
        targetId: "player-3",
        attackType: AttackType.MAGIC,
        damage: 8,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 2, z: 0 },
      });

      expect(service.hasActiveProjectilesBetween("player-1", "player-2")).toBe(
        true,
      );
      expect(service.hasActiveProjectilesBetween("player-1", "player-4")).toBe(
        false,
      );

      service.cancelProjectilesBetween("player-1", "player-2");
      expect(service.hasActiveProjectilesBetween("player-1", "player-2")).toBe(
        false,
      );
      expect(service.hasActiveProjectilesBetween("player-1", "player-3")).toBe(
        true,
      );
      expect(service.hasActiveProjectilesBetween("player-1", "player-1")).toBe(
        false,
      );
    });
  });

  describe("getProjectilesForTarget", () => {
    it("returns empty array when no projectiles", () => {
      expect(service.getProjectilesForTarget("mob-1")).toHaveLength(0);
    });

    it("returns active projectiles for target", () => {
      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      service.createProjectile({
        sourceId: "player-2",
        targetId: "mob-1",
        attackType: AttackType.MAGIC,
        damage: 8,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      const projectiles = service.getProjectilesForTarget("mob-1");

      expect(projectiles).toHaveLength(2);
    });

    it("excludes cancelled projectiles", () => {
      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      service.cancelProjectilesForTarget("mob-1");

      expect(service.getProjectilesForTarget("mob-1")).toHaveLength(0);
    });
  });

  describe("getProjectile", () => {
    it("returns projectile by ID", () => {
      const created = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      const retrieved = service.getProjectile(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it("returns undefined for unknown ID", () => {
      expect(service.getProjectile("unknown-id")).toBeUndefined();
    });
  });

  describe("clear", () => {
    it("removes all projectiles", () => {
      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-2",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });

      expect(service.getActiveCount()).toBe(2);

      service.clear();

      expect(service.getActiveCount()).toBe(0);
      expect(service.getProjectilesForTarget("mob-1")).toHaveLength(0);
      expect(service.getProjectilesForTarget("mob-2")).toHaveLength(0);
    });
  });

  describe("hit delay formulas", () => {
    it("melee has immediate hit (same tick)", () => {
      const projectile = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.MELEE,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 1, z: 0 },
      });

      // Melee should hit on same tick (immediate)
      expect(projectile.hitsAtTick).toBe(100);
    });

    it("ranged delay increases with distance", () => {
      const close = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 1, z: 0 },
      });

      const far = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-2",
        attackType: AttackType.RANGED,
        damage: 10,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 10, z: 0 },
      });

      expect(far.hitsAtTick).toBeGreaterThan(close.hitsAtTick);
    });

    it("magic delay increases with distance", () => {
      const close = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.MAGIC,
        damage: 8,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 1, z: 0 },
      });

      const far = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-2",
        attackType: AttackType.MAGIC,
        damage: 8,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 10, z: 0 },
      });

      expect(far!.hitsAtTick).toBeGreaterThan(close!.hitsAtTick);
    });
  });

  describe("per-player projectile limit", () => {
    it("returns null when attacker exceeds 10 active projectiles", () => {
      // Create 10 projectiles from same attacker
      for (let i = 0; i < 10; i++) {
        const p = service.createProjectile({
          sourceId: "player-1",
          targetId: `mob-${i}`,
          attackType: AttackType.RANGED,
          damage: 5,
          currentTick: 100,
          sourcePosition: { x: 0, z: 0 },
          targetPosition: { x: 5 + i, z: 0 },
        });
        expect(p).not.toBeNull();
      }

      // 11th should be rejected
      const rejected = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-10",
        attackType: AttackType.RANGED,
        damage: 5,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 15, z: 0 },
      });
      expect(rejected).toBeNull();
    });

    it("allows projectiles from different attackers independently", () => {
      // Fill up player-1
      for (let i = 0; i < 10; i++) {
        service.createProjectile({
          sourceId: "player-1",
          targetId: `mob-${i}`,
          attackType: AttackType.RANGED,
          damage: 5,
          currentTick: 100,
          sourcePosition: { x: 0, z: 0 },
          targetPosition: { x: 5, z: 0 },
        });
      }

      // player-2 should still be allowed
      const p = service.createProjectile({
        sourceId: "player-2",
        targetId: "mob-0",
        attackType: AttackType.RANGED,
        damage: 5,
        currentTick: 100,
        sourcePosition: { x: 10, z: 0 },
        targetPosition: { x: 15, z: 0 },
      });
      expect(p).not.toBeNull();
    });

    it("allows new projectiles after old ones are processed", () => {
      // Create 10 projectiles that hit at tick 102
      for (let i = 0; i < 10; i++) {
        service.createProjectile({
          sourceId: "player-1",
          targetId: `mob-${i}`,
          attackType: AttackType.MELEE,
          damage: 5,
          currentTick: 100,
          sourcePosition: { x: 0, z: 0 },
          targetPosition: { x: 0, z: 0 },
        });
      }

      // Process tick to clear melee projectiles (instant hit)
      service.processTick(100);

      // Should be able to create more now
      const p = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-0",
        attackType: AttackType.RANGED,
        damage: 5,
        currentTick: 101,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });
      expect(p).not.toBeNull();
    });
  });

  describe("getActiveCountForAttacker", () => {
    it("returns 0 for unknown attacker", () => {
      expect(service.getActiveCountForAttacker("unknown")).toBe(0);
    });

    it("counts only non-cancelled projectiles", () => {
      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-1",
        attackType: AttackType.RANGED,
        damage: 5,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 5, z: 0 },
      });
      service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-2",
        attackType: AttackType.RANGED,
        damage: 5,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 10, z: 0 },
      });

      expect(service.getActiveCountForAttacker("player-1")).toBe(2);

      // Cancel one target's projectiles
      service.cancelProjectilesForTarget("mob-1");
      expect(service.getActiveCountForAttacker("player-1")).toBe(1);
    });
  });

  describe("lifecycle diagnostics", () => {
    it("reconciles every accepted launch to a hit, cancellation, or expiry", () => {
      const hit = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-hit",
        attackType: AttackType.RANGED,
        damage: 5,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 1, z: 0 },
      })!;
      const cancelled = service.createProjectile({
        sourceId: "player-1",
        targetId: "mob-cancelled",
        attackType: AttackType.RANGED,
        damage: 5,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 1, z: 0 },
      })!;
      const expired = service.createProjectile({
        sourceId: "player-2",
        targetId: "mob-expired",
        attackType: AttackType.RANGED,
        damage: 5,
        currentTick: 100,
        sourcePosition: { x: 0, z: 0 },
        targetPosition: { x: 1, z: 0 },
      })!;
      expired.hitsAtTick = 999;

      service.cancelProjectilesForTarget("mob-cancelled");
      service.processTick(hit.hitsAtTick);
      service.processTick(121);

      const diagnostics = service.getLifecycleDiagnostics();
      expect(diagnostics).toMatchObject({
        active: 0,
        launched: 3,
        hit: 1,
        cancelled: 1,
        expired: 1,
        latestSequence: 6,
      });
      expect(
        diagnostics.recent.map(({ kind, projectileId }) => ({
          kind,
          projectileId,
        })),
      ).toEqual(
        expect.arrayContaining([
          { kind: "hit", projectileId: hit.id },
          { kind: "cancelled", projectileId: cancelled.id },
          { kind: "expired", projectileId: expired.id },
        ]),
      );
    });
  });

  describe("stress test", () => {
    it("handles many projectiles across multiple attackers and targets", () => {
      const attackers = 5;
      const targetsPerAttacker = 8;

      for (let a = 0; a < attackers; a++) {
        for (let t = 0; t < targetsPerAttacker; t++) {
          service.createProjectile({
            sourceId: `player-${a}`,
            targetId: `mob-${a}-${t}`,
            attackType: AttackType.RANGED,
            damage: 5,
            currentTick: 100,
            sourcePosition: { x: a * 10, z: 0 },
            targetPosition: { x: a * 10 + 5, z: t * 5 },
          });
        }
      }

      expect(service.getActiveCount()).toBe(attackers * targetsPerAttacker);

      // Cancel all projectiles for one target
      service.cancelProjectilesForTarget("mob-2-3");
      expect(service.getActiveCount()).toBe(attackers * targetsPerAttacker - 1);

      // Cancel all from one attacker
      service.cancelProjectilesFromAttacker("player-0");
      expect(service.getActiveCountForAttacker("player-0")).toBe(0);
    });
  });
});
