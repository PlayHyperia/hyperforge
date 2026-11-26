import { describe, expect, it, vi } from "vitest";

import { AttackType } from "../../../../../types/core/core";
import type { EntityID } from "../../../../../types/core/identifiers";
import { CombatSystem } from "../../CombatSystem";
import type { CombatData } from "../../CombatStateService";

describe("CombatSystem projectile liveness", () => {
  it("quiesces both exact combatants without cancelling the projectile boundary", () => {
    const attackerId = "attacker" as EntityID;
    const targetId = "target" as EntityID;
    const attackerState: CombatData = {
      attackerId,
      targetId,
      attackerType: "player",
      targetType: "player",
      weaponType: AttackType.RANGED,
      inCombat: true,
      lastAttackTick: 80,
      nextAttackTick: 100,
      combatEndTick: 110,
      attackSpeedTicks: 5,
    };
    const targetState: CombatData = {
      attackerId: targetId,
      targetId: attackerId,
      attackerType: "player",
      targetType: "player",
      weaponType: AttackType.RANGED,
      inCombat: true,
      lastAttackTick: 80,
      nextAttackTick: 100,
      combatEndTick: 110,
      attackSpeedTicks: 5,
    };
    const combatStates = new Map<EntityID, CombatData>([
      [attackerId, attackerState],
      [targetId, targetState],
    ]);
    const processAutoAttackOnTick = vi.fn(async () => undefined);
    const processEntityEmoteReset = vi.fn();
    const system = Object.assign(Object.create(CombatSystem.prototype), {
      autoAttackQuiescedEntities: new Set<EntityID>(),
      stateService: {
        getCombatData: (entityId: EntityID | string) =>
          combatStates.get(entityId as EntityID),
      },
      animationManager: { processEntityEmoteReset },
      checkRangeAndFollow: vi.fn(),
      processAutoAttackOnTick,
    }) as CombatSystem;

    expect(system.quiesceAutoAttacksBetween(attackerId, targetId)).toBe(true);
    system.processPlayerCombatTick(attackerId, 100);
    system.processPlayerCombatTick(targetId, 100);

    expect(processEntityEmoteReset).toHaveBeenCalledTimes(2);
    expect(processAutoAttackOnTick).not.toHaveBeenCalled();
    expect(system.quiesceAutoAttacksBetween(attackerId, "bystander")).toBe(
      false,
    );
  });

  it.each([AttackType.RANGED, AttackType.MAGIC])(
    "does not keep combat alive when a %s launch is rejected",
    async (attackType) => {
      const attackerId = "attacker" as EntityID;
      const combatState: CombatData = {
        attackerId,
        targetId: "target" as EntityID,
        attackerType: "player",
        targetType: "player",
        weaponType: attackType,
        inCombat: true,
        lastAttackTick: 80,
        nextAttackTick: 100,
        combatEndTick: 110,
        attackSpeedTicks: 5,
      };
      const combatStates = new Map([[attackerId, combatState]]);
      const handleAttack = vi.fn(async () => undefined);
      const system = Object.assign(Object.create(CombatSystem.prototype), {
        validateCombatActors: () => ({ attacker: {}, target: {} }),
        getAttackTypeFromWeapon: () => attackType,
        handleAttack,
        stateService: {
          getCombatStatesMap: () => combatStates,
        },
      }) as unknown as {
        processAutoAttackOnTick(
          state: CombatData,
          tickNumber: number,
        ): Promise<void>;
      };

      await system.processAutoAttackOnTick(combatState, 100);

      expect(handleAttack).toHaveBeenCalledOnce();
      expect(combatState).toMatchObject({
        lastAttackTick: 80,
        nextAttackTick: 100,
        combatEndTick: 110,
      });
    },
  );
});
