import { AttackType } from "@hyperforge/shared";
import { describe, expect, it, vi } from "vitest";
import { EmbeddedHyperiaService } from "../EmbeddedHyperiaService";

function createMockWorld(overrides?: Record<string, unknown>) {
  const entities = new Map();
  const systems = new Map();

  const world = {
    entities: {
      get: (id: string) => entities.get(id),
      values: () => entities.values(),
      add: vi.fn().mockReturnValue("new-entity-id"),
      items: () => entities.entries(),
      [Symbol.iterator]: () => entities.entries(),
    },
    getSystem: (name: string) => systems.get(name) ?? null,
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    isServer: true,
    network: null,
    ...overrides,
  };

  return { world, entities, systems };
}

describe("EmbeddedHyperiaService new methods", () => {
  describe("competitive recovery custody holds", () => {
    it("keeps overlapping recovery holds separate from the configured autonomy baseline", () => {
      const { world } = createMockWorld();
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      const preparationA = "00000000-0000-4000-8000-000000000001";
      const preparationB = "00000000-0000-4000-8000-000000000002";

      expect(service.isAutonomousBehaviorConfigured()).toBe(true);
      expect(service.isAutonomousEnabled()).toBe(true);

      service.setCompetitiveRecoveryCustodyHold(preparationA, true);
      service.setCompetitiveRecoveryCustodyHold(preparationB, true);
      expect(service.isAutonomousBehaviorConfigured()).toBe(true);
      expect(service.isAutonomousEnabled()).toBe(false);

      service.setCompetitiveRecoveryCustodyHold(preparationA, false);
      expect(service.isAutonomousEnabled()).toBe(false);
      service.setCompetitiveRecoveryCustodyHold(preparationB, false);
      expect(service.isAutonomousEnabled()).toBe(true);

      service.setAutonomousBehaviorEnabled(false);
      service.setCompetitiveRecoveryCustodyHold(preparationA, true);
      service.setCompetitiveRecoveryCustodyHold(preparationA, false);
      expect(service.isAutonomousBehaviorConfigured()).toBe(false);
      expect(service.isAutonomousEnabled()).toBe(false);

      service.setAutonomousBehaviorEnabled(true);
      expect(service.isAutonomousEnabled()).toBe(true);
    });
  });

  describe("authoritative combat ownership", () => {
    it("requires an active CombatSystem engagement with the exact target", () => {
      const { world, entities, systems } = createMockWorld();
      entities.set("agent-1", { data: {} });
      let inCombat = true;
      let targetId = "agent-2";
      const isInCombat = vi.fn(() => inCombat);
      const getCombatData = vi.fn(() => ({ inCombat, targetId }));
      systems.set("combat", { isInCombat, getCombatData });
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      expect(service.isAuthoritativelyInCombatWith("agent-2")).toBe(true);
      expect(isInCombat).toHaveBeenCalledWith("agent-1");
      expect(getCombatData).toHaveBeenCalledWith("agent-1");

      targetId = "agent-3";
      expect(service.isAuthoritativelyInCombatWith("agent-2")).toBe(false);

      targetId = "agent-2";
      inCombat = false;
      expect(service.isAuthoritativelyInCombatWith("agent-2")).toBe(false);
    });

    it("fails closed when combat authority is unavailable", () => {
      const { world, entities } = createMockWorld();
      entities.set("agent-1", { data: {} });
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      expect(service.isAuthoritativelyInCombatWith("agent-2")).toBe(false);
    });

    it("delegates exact live tiles and equipped range to network attack authority", () => {
      const { world, entities, systems } = createMockWorld();
      entities.set("agent-1", {
        data: {},
        position: { x: 10.5, y: 0, z: 10.5 },
      });
      const target = {
        data: {},
        position: { x: 10.5, y: 0, z: 11.5 },
      };
      entities.set("agent-2", target);
      const isInAttackRange = vi.fn(
        (
          attackerTile: { x: number; z: number },
          targetTile: { x: number; z: number },
        ) =>
          Math.abs(attackerTile.x - targetTile.x) +
            Math.abs(attackerTile.z - targetTile.z) ===
          1,
      );
      systems.set("network", {
        getPlayerWeaponRange: vi.fn(() => 1),
        getPlayerAttackType: vi.fn(() => AttackType.MELEE),
        isInAttackRange,
      });
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      expect(service.isTargetInAuthoritativeAttackRange("agent-2")).toBe(true);
      expect(isInAttackRange).toHaveBeenLastCalledWith(
        { x: 10, z: 10 },
        { x: 10, z: 11 },
        AttackType.MELEE,
        1,
      );

      target.position.x = 11.5;
      expect(service.isTargetInAuthoritativeAttackRange("agent-2")).toBe(false);
      expect(isInAttackRange).toHaveBeenLastCalledWith(
        { x: 10, z: 10 },
        { x: 11, z: 11 },
        AttackType.MELEE,
        1,
      );
    });
  });

  describe("durable duel executor commands", () => {
    it("stages before movement and retries one ambiguous completion exactly", async () => {
      const { world, entities, systems } = createMockWorld();
      entities.set("agent-1", { data: {} });
      const requestServerMove = vi.fn(() => true);
      systems.set("network", { requestServerMove });

      let releaseStage!: () => void;
      const stageGate = new Promise<void>((resolve) => {
        releaseStage = resolve;
      });
      const stageStreamingDuelExecutorCommandAsync = vi.fn(
        async (request: Record<string, unknown>) => {
          await stageGate;
          return {
            ...request,
            replayed: false,
            completed: false,
            outcome: null,
          };
        },
      );
      let completionAttempts = 0;
      const completeStreamingDuelExecutorCommandAsync = vi.fn(
        async (request: Record<string, unknown>) => {
          completionAttempts++;
          if (completionAttempts === 1) {
            throw new Error("response lost after commit");
          }
          return {
            ...request,
            replayed: true,
            completed: true,
          };
        },
      );
      systems.set("database", {
        stageStreamingDuelExecutorCommandAsync,
        completeStreamingDuelExecutorCommandAsync,
      });
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;
      const context = {
        operationId: "00000000-0000-4000-8000-000000000601",
        tick: 6,
        observedAt: 1_800_000_000_600,
        cycleId: "cycle-executor",
        duelId: "duel-executor",
        actorId: "agent-1",
        opponentId: "agent-2",
        phase: "FIGHTING" as const,
        combatRole: "ranged" as const,
        tacticalMacro: "kite" as const,
        action: "movement" as const,
        value: "reposition" as const,
      };

      const pending = service.executeDuelMove([4.5, 0, 7.5], true, context);
      await vi.waitFor(() => {
        expect(stageStreamingDuelExecutorCommandAsync).toHaveBeenCalledOnce();
      });
      expect(requestServerMove).not.toHaveBeenCalled();
      releaseStage();

      await expect(pending).resolves.toMatchObject({
        operationId: context.operationId,
        completed: true,
        outcome: "accepted",
      });
      expect(requestServerMove).toHaveBeenCalledOnce();
      expect(completeStreamingDuelExecutorCommandAsync).toHaveBeenCalledTimes(
        2,
      );
      expect(
        completeStreamingDuelExecutorCommandAsync.mock.calls[0]?.[0],
      ).toEqual(completeStreamingDuelExecutorCommandAsync.mock.calls[1]?.[0]);
    });

    it("fails before staging a mismatched competitive actor", async () => {
      const { world, entities, systems } = createMockWorld();
      entities.set("agent-1", { data: {} });
      const stageStreamingDuelExecutorCommandAsync = vi.fn();
      systems.set("database", {
        stageStreamingDuelExecutorCommandAsync,
        completeStreamingDuelExecutorCommandAsync: vi.fn(),
      });
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      await expect(
        service.executeDuelAttack("agent-2", {
          operationId: "00000000-0000-4000-8000-000000000602",
          tick: 6,
          observedAt: 1_800_000_000_601,
          cycleId: "cycle-executor",
          duelId: "duel-executor",
          actorId: "forged-agent",
          opponentId: "agent-2",
          phase: "FIGHTING",
          combatRole: "ranged",
          tacticalMacro: "kite",
          action: "engagement",
          value: "initial",
        }),
      ).rejects.toThrow("streaming_duel_executor_context_invalid");
      expect(stageStreamingDuelExecutorCommandAsync).not.toHaveBeenCalled();
    });

    it("reconciles one unresolved command before admitting a newer executor side effect", async () => {
      const { world, entities, systems } = createMockWorld();
      entities.set("agent-1", { data: {} });
      entities.set("agent-2", { data: {} });
      const requestServerMove = vi.fn(() => true);
      const requestServerAttack = vi.fn(() => true);
      systems.set("network", { requestServerMove, requestServerAttack });

      const staged = new Map<string, Record<string, unknown>>();
      const authorityOrder: string[] = [];
      const stageStreamingDuelExecutorCommandAsync = vi.fn(
        async (request: Record<string, unknown>) => {
          const operationId = String(request.operationId);
          authorityOrder.push(`stage:${operationId}`);
          const existing = staged.get(operationId);
          if (existing) {
            return { ...existing, replayed: true };
          }
          const receipt = {
            ...request,
            replayed: false,
            completed: false,
            outcome: null,
          };
          staged.set(operationId, receipt);
          return receipt;
        },
      );
      let firstCompletionFailures = 0;
      const completeStreamingDuelExecutorCommandAsync = vi.fn(
        async (request: Record<string, unknown>) => {
          const operationId = String(request.operationId);
          authorityOrder.push(`complete:${operationId}`);
          if (
            operationId === "00000000-0000-4000-8000-000000000603" &&
            firstCompletionFailures++ < 2
          ) {
            throw new Error("database temporarily unavailable");
          }
          const receipt = {
            ...request,
            replayed: false,
            completed: true,
          };
          staged.set(operationId, receipt);
          return receipt;
        },
      );
      systems.set("database", {
        stageStreamingDuelExecutorCommandAsync,
        completeStreamingDuelExecutorCommandAsync,
      });
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;
      const baseContext = {
        tick: 6,
        observedAt: 1_800_000_000_600,
        cycleId: "cycle-executor",
        duelId: "duel-executor",
        actorId: "agent-1",
        opponentId: "agent-2",
        phase: "FIGHTING" as const,
        combatRole: "ranged" as const,
        tacticalMacro: "kite" as const,
      };
      const movementOperationId = "00000000-0000-4000-8000-000000000603";
      const engagementOperationId = "00000000-0000-4000-8000-000000000604";

      await expect(
        service.executeDuelMove([4.5, 0, 7.5], true, {
          ...baseContext,
          operationId: movementOperationId,
          action: "movement",
          value: "reposition",
        }),
      ).rejects.toThrow("streaming_duel_executor_persistence_failed");
      expect(requestServerMove).toHaveBeenCalledOnce();
      expect(requestServerAttack).not.toHaveBeenCalled();

      await expect(
        service.executeDuelAttack("agent-2", {
          ...baseContext,
          operationId: engagementOperationId,
          tick: 7,
          observedAt: baseContext.observedAt + 1,
          action: "engagement",
          value: "initial",
        }),
      ).resolves.toMatchObject({
        operationId: engagementOperationId,
        completed: true,
        outcome: "accepted",
      });

      expect(requestServerMove).toHaveBeenCalledTimes(2);
      expect(requestServerAttack).toHaveBeenCalledOnce();
      expect(authorityOrder).toEqual([
        `stage:${movementOperationId}`,
        `complete:${movementOperationId}`,
        `complete:${movementOperationId}`,
        `stage:${movementOperationId}`,
        `complete:${movementOperationId}`,
        `stage:${engagementOperationId}`,
        `complete:${engagementOperationId}`,
      ]);
    });
  });

  describe("executeChangeStyle", () => {
    it("rejects invalid styles", async () => {
      const { world, entities } = createMockWorld();
      entities.set("agent-1", { data: {} });

      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      const result = await service.executeChangeStyle("invalid_style");
      expect(result).toBe(false);
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("accepts valid styles", async () => {
      const { world, entities } = createMockWorld();
      entities.set("agent-1", { data: {} });

      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      const result = await service.executeChangeStyle("aggressive");
      expect(result).toBe(true);
      expect(world.emit).toHaveBeenCalled();
    });

    it("returns only the authoritative PlayerSystem receipt when available", async () => {
      const { world, entities, systems } = createMockWorld();
      entities.set("agent-1", { data: {} });
      const changeAttackStyleAtomic = vi.fn(async () => ({
        ok: false,
        currentStyle: "accurate",
        reason: "style_not_available",
      }));
      systems.set("player", { changeAttackStyleAtomic });
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      await expect(service.executeChangeStyle("rapid")).resolves.toBe(false);
      expect(service.getLastStyleChangeFailureReason()).toBe(
        "style_not_available",
      );
      expect(changeAttackStyleAtomic).toHaveBeenCalledWith(
        "agent-1",
        "rapid",
        undefined,
      );
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("never downgrades a duel style receipt to the legacy event fallback", async () => {
      const { world, entities } = createMockWorld();
      entities.set("agent-1", { data: {} });
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;
      const context = {
        operationId: "00000000-0000-4000-8000-000000000502",
        tick: 2,
        observedAt: 1_800_000_000_020,
        cycleId: "cycle-style",
        duelId: "duel-style",
        actorId: "agent-1",
        opponentId: "agent-2",
        phase: "FIGHTING" as const,
        combatRole: "ranged" as const,
        tacticalMacro: "kite" as const,
        style: "rapid" as const,
      };

      await expect(service.executeChangeStyle("rapid", context)).resolves.toBe(
        false,
      );
      expect(service.getLastStyleChangeFailureReason()).toBe(
        "atomic_persistence_unavailable",
      );
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("returns false when not active", async () => {
      const { world } = createMockWorld();
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );

      const result = await service.executeChangeStyle("aggressive");
      expect(result).toBe(false);
      expect(service.getLastStyleChangeFailureReason()).toBe(
        "service_inactive",
      );
    });
  });

  describe("executeSetAutocast", () => {
    it("sets a known level-compatible spell on both authoritative views", async () => {
      const player = {
        data: { skills: { magic: { level: 13, xp: 0 } } },
      };
      const { world, entities, systems } = createMockWorld({
        getPlayer: () => player,
      });
      const savePlayerAsync = vi.fn(async () => undefined);
      systems.set("database", { savePlayerAsync });
      entities.set("agent-1", player);
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      const result = await service.executeSetAutocast("fire_strike");

      expect(result).toBe(true);
      expect(savePlayerAsync).toHaveBeenCalledWith("agent-1", {
        selectedSpell: "fire_strike",
      });
      expect(player.data).toMatchObject({ selectedSpell: "fire_strike" });
      expect(world.emit).toHaveBeenCalledWith("player:set_autocast", {
        playerId: "agent-1",
        spellId: "fire_strike",
      });
    });

    it("rejects unknown or level-incompatible spells without changing state", async () => {
      const { world, entities } = createMockWorld();
      entities.set("agent-1", {
        data: {
          selectedSpell: null,
          skills: { magic: { level: 1, xp: 0 } },
        },
      });
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      expect(await service.executeSetAutocast("fire_strike")).toBe(false);
      expect(await service.executeSetAutocast("unknown_spell")).toBe(false);
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("fails closed without durable persistence authority", async () => {
      const player = {
        data: {
          selectedSpell: null,
          skills: { magic: { level: 13, xp: 0 } },
        },
      };
      const { world, entities } = createMockWorld({ getPlayer: () => player });
      entities.set("agent-1", player);
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      expect(await service.executeSetAutocast("fire_strike")).toBe(false);
      expect(player.data.selectedSpell).toBeNull();
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("does not publish a spell selection when persistence rejects it", async () => {
      const player = {
        data: {
          selectedSpell: null,
          skills: { magic: { level: 13, xp: 0 } },
        },
      };
      const { world, entities, systems } = createMockWorld({
        getPlayer: () => player,
      });
      systems.set("database", {
        savePlayerAsync: vi.fn(async () => {
          throw new Error("database unavailable");
        }),
      });
      entities.set("agent-1", player);
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      expect(await service.executeSetAutocast("fire_strike")).toBe(false);
      expect(player.data.selectedSpell).toBeNull();
      expect(world.emit).not.toHaveBeenCalled();
    });
  });

  describe("executeHomeTeleport", () => {
    it("blocks teleport during combat", async () => {
      const { world, entities } = createMockWorld();
      entities.set("agent-1", { data: { inCombat: true } });

      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      const result = await service.executeHomeTeleport();
      expect(result).toBe(false);
      expect(world.emit).not.toHaveBeenCalled();
    });

    it("blocks teleport during duel", async () => {
      const { world, entities } = createMockWorld();
      entities.set("agent-1", { data: { inStreamingDuel: true } });

      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      const result = await service.executeHomeTeleport();
      expect(result).toBe(false);
    });

    it("allows teleport when idle", async () => {
      const { world, entities } = createMockWorld();
      entities.set("agent-1", { data: {} });

      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      const result = await service.executeHomeTeleport();
      expect(result).toBe(true);
      expect(world.emit).toHaveBeenCalled();
    });
  });

  describe("executePrayerToggle", () => {
    it("rejects empty prayer ID", async () => {
      const { world } = createMockWorld();
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      const result = await service.executePrayerToggle("");
      expect(result).toMatchObject({
        success: false,
        committed: false,
        reason: "invalid_request",
      });
    });

    it("returns false when prayer system unavailable", async () => {
      const { world } = createMockWorld();
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      const result = await service.executePrayerToggle("superhuman_strength");
      expect(result).toMatchObject({
        success: false,
        committed: false,
        reason: "atomic_persistence_unavailable",
      });
    });

    it("calls prayer system when available", async () => {
      const { world, systems } = createMockWorld();
      const mockToggle = vi.fn(
        async (playerId: string, _prayerId: string, operationId: string) => ({
          success: true,
          committed: true,
          playerId,
          operationId,
          replayed: false,
          pointUnits: 4_000_000,
          points: 4,
          maxPoints: 5,
          activePrayers: ["superhuman_strength"],
        }),
      );
      systems.set("prayer", { togglePrayer: mockToggle });

      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;

      const result = await service.executePrayerToggle("superhuman_strength");
      expect(result).toMatchObject({
        success: true,
        committed: true,
        activePrayers: ["superhuman_strength"],
      });
      expect(mockToggle).toHaveBeenCalledWith(
        "agent-1",
        "superhuman_strength",
        expect.stringMatching(/^agent-prayer-toggle:/),
      );
    });

    it("threads a duel prayer observation through the same toggle call", async () => {
      const { world, systems } = createMockWorld();
      const mockToggle = vi.fn(
        async (playerId: string, _prayerId: string, operationId: string) => ({
          success: true,
          committed: true,
          playerId,
          operationId,
          replayed: false,
          pointUnits: 4_000_000,
          points: 4,
          maxPoints: 5,
          activePrayers: ["superhuman_strength"],
        }),
      );
      systems.set("prayer", { togglePrayer: mockToggle });
      const service = new EmbeddedHyperiaService(
        world as never,
        "agent-1",
        "account-1",
        "TestAgent",
      );
      (service as unknown as { playerEntityId: string }).playerEntityId =
        "agent-1";
      (service as unknown as { isActive: boolean }).isActive = true;
      const context = {
        operationId: "00000000-0000-4000-8000-000000000012",
        tick: 2,
        observedAt: 1_725_000_000_200,
        cycleId: "cycle-prayer",
        duelId: "duel-prayer",
        actorId: "agent-1",
        opponentId: "agent-2",
        phase: "FIGHTING" as const,
        combatRole: "melee" as const,
        tacticalMacro: "pressure" as const,
        prayer: "superhuman_strength" as const,
      };

      const result = await service.executePrayerToggle(
        "superhuman_strength",
        context,
      );

      expect(result.committed).toBe(true);
      expect(mockToggle).toHaveBeenCalledWith(
        "agent-1",
        "superhuman_strength",
        expect.stringMatching(/^agent-prayer-toggle:/),
        context,
      );
    });
  });
});
