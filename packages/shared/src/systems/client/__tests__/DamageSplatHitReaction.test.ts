import { describe, expect, it, vi } from "vitest";

import { EventType } from "../../../types/events";
import type { CombatDamageDealtPayload } from "../../../types/events/event-payloads";
import {
  getPlayerHitReactionIntensity,
  getPlayerHitReactionSide,
} from "../../../utils/rendering/HitReaction";
import {
  DamageSplatSystem,
  triggerPlayerDamageReaction,
} from "../DamageSplatSystem";

function damage(
  overrides: Partial<CombatDamageDealtPayload> = {},
): CombatDamageDealtPayload {
  return {
    attackerId: "attacker-a",
    targetId: "target-b",
    damage: 9,
    targetType: "player",
    ...overrides,
  };
}

describe("damage-synchronized player hit reactions", () => {
  it("triggers one deterministic additive reaction for a positive player hit", () => {
    const triggerHitReaction = vi.fn();
    const target = {
      isPlayer: true,
      avatar: { triggerHitReaction },
    };
    const payload = damage({ isCritical: true });

    expect(triggerPlayerDamageReaction(target, payload)).toBe(true);
    expect(triggerHitReaction).toHaveBeenCalledOnce();
    expect(triggerHitReaction).toHaveBeenCalledWith(
      getPlayerHitReactionIntensity(payload.damage, true),
      getPlayerHitReactionSide(payload.attackerId, payload.targetId),
    );
  });

  it("ignores misses, mobs, unavailable avatars, and non-finite damage", () => {
    const triggerHitReaction = vi.fn();
    const player = {
      isPlayer: true,
      avatar: { triggerHitReaction },
    };

    expect(triggerPlayerDamageReaction(player, damage({ damage: 0 }))).toBe(
      false,
    );
    expect(
      triggerPlayerDamageReaction(player, damage({ damage: Number.NaN })),
    ).toBe(false);
    expect(
      triggerPlayerDamageReaction(player, damage({ targetType: "mob" })),
    ).toBe(false);
    expect(triggerPlayerDamageReaction({ isPlayer: true }, damage())).toBe(
      false,
    );
    expect(triggerPlayerDamageReaction(null, damage())).toBe(false);
    expect(triggerHitReaction).not.toHaveBeenCalled();
  });

  it("uses entity identity when older payloads omit target type", () => {
    const triggerHitReaction = vi.fn();
    const payload = damage({ targetType: undefined });

    expect(
      triggerPlayerDamageReaction(
        { isPlayer: true, avatar: { triggerHitReaction } },
        payload,
      ),
    ).toBe(true);
    expect(
      triggerPlayerDamageReaction(
        { isPlayer: false, avatar: { triggerHitReaction } },
        payload,
      ),
    ).toBe(false);
  });

  it("retains an exact projectile-to-splat-to-reaction presentation receipt", () => {
    let triggerCount = 0;
    const target = {
      isPlayer: true,
      position: { x: 4, y: 0, z: 2 },
      avatar: {
        triggerHitReaction: () => {
          triggerCount++;
        },
        instance: {
          getHitReactionDiagnostics: () => ({ triggerCount }),
        },
      },
    };
    const world = {
      isClient: true,
      entities: { get: vi.fn(() => target) },
    };
    const system = new DamageSplatSystem(world as never);
    const createDamageSplat = vi.fn(() => true);
    (
      system as unknown as {
        createDamageSplat: typeof createDamageSplat;
        onDamageDealt: (payload: CombatDamageDealtPayload) => void;
      }
    ).createDamageSplat = createDamageSplat;

    (
      system as unknown as {
        onDamageDealt: (payload: CombatDamageDealtPayload) => void;
      }
    ).onDamageDealt(
      damage({
        projectileId: "projectile-42",
        attackType: "ranged",
        targetType: "player",
      }),
    );

    expect(system.getStreamingDamagePresentationDiagnostics()).toMatchObject({
      schemaVersion: 1,
      latestSequence: 1,
      recentEvents: [
        {
          sequence: 1,
          projectileId: "projectile-42",
          attackerId: "attacker-a",
          targetId: "target-b",
          attackType: "ranged",
          damage: 9,
          hitReactionTriggered: true,
          hitReactionTriggerCount: 1,
          damageSplatCreated: true,
        },
      ],
    });
  });

  it("clears contestant splats and rejects late visual feedback after fighting ends", () => {
    const triggerHitReaction = vi.fn();
    const target = {
      isPlayer: true,
      position: { x: 4, y: 0, z: 2 },
      avatar: { triggerHitReaction },
    };
    const world = {
      isClient: true,
      entities: { get: vi.fn(() => target) },
    };
    const system = new DamageSplatSystem(world as never);
    const createDamageSplat = vi.fn(() => true);
    const releaseSplat = vi.fn();
    const activeContestantSplat = { targetId: "target-b" };
    const testable = system as unknown as {
      activeSplats: Array<{ targetId: string | null }>;
      createDamageSplat: typeof createDamageSplat;
      releaseSplat: typeof releaseSplat;
      onDamageDealt: (payload: CombatDamageDealtPayload) => void;
      onStreamingStateUpdate: (payload: unknown) => void;
    };
    testable.createDamageSplat = createDamageSplat;
    testable.releaseSplat = releaseSplat;

    testable.onStreamingStateUpdate({
      cycle: {
        phase: "FIGHTING",
        agent1: { id: "attacker-a" },
        agent2: { id: "target-b" },
      },
    });
    testable.onDamageDealt(damage());
    expect(createDamageSplat).toHaveBeenCalledOnce();
    expect(triggerHitReaction).toHaveBeenCalledOnce();

    testable.activeSplats = [activeContestantSplat];
    testable.onStreamingStateUpdate({
      cycle: {
        phase: "RESOLUTION",
        agent1: { id: "attacker-a" },
        agent2: { id: "target-b" },
      },
    });

    expect(releaseSplat).toHaveBeenCalledExactlyOnceWith(activeContestantSplat);
    expect(testable.activeSplats).toEqual([]);

    testable.onDamageDealt(damage({ projectileId: "late-projectile" }));
    expect(createDamageSplat).toHaveBeenCalledOnce();
    expect(triggerHitReaction).toHaveBeenCalledOnce();
    expect(system.getStreamingDamagePresentationDiagnostics()).toMatchObject({
      activeSplatCount: 0,
      latestSequence: 2,
      recentEvents: [
        { damageSplatCreated: true, hitReactionTriggered: true },
        {
          projectileId: "late-projectile",
          damageSplatCreated: false,
          hitReactionTriggered: false,
        },
      ],
    });
  });

  it("does not suppress unrelated world combat outside the streamed duel", () => {
    const triggerHitReaction = vi.fn();
    const target = {
      isPlayer: true,
      position: { x: 8, y: 0, z: 3 },
      avatar: { triggerHitReaction },
    };
    const world = {
      isClient: true,
      entities: { get: vi.fn(() => target) },
    };
    const system = new DamageSplatSystem(world as never);
    const createDamageSplat = vi.fn(() => true);
    const testable = system as unknown as {
      createDamageSplat: typeof createDamageSplat;
      onDamageDealt: (payload: CombatDamageDealtPayload) => void;
      onStreamingStateUpdate: (payload: unknown) => void;
    };
    testable.createDamageSplat = createDamageSplat;
    testable.onStreamingStateUpdate({
      cycle: {
        phase: "RESOLUTION",
        agent1: { id: "duelist-a" },
        agent2: { id: "duelist-b" },
      },
    });

    testable.onDamageDealt(
      damage({ attackerId: "world-a", targetId: "world-b" }),
    );

    expect(createDamageSplat).toHaveBeenCalledOnce();
    expect(triggerHitReaction).toHaveBeenCalledOnce();
  });

  it("registers each runtime listener once and removes both on destroy", async () => {
    const registered = new Map<string, (payload: unknown) => void>();
    const on = vi.fn((event: string, handler: (payload: unknown) => void) => {
      registered.set(event, handler);
    });
    const off = vi.fn();
    const world = {
      isClient: true,
      entities: { get: vi.fn(() => null) },
      on,
      off,
    };
    const system = new DamageSplatSystem(world as never);

    await system.init({} as never);
    await system.init({} as never);

    expect(on).toHaveBeenCalledTimes(2);
    expect(registered.has(EventType.COMBAT_DAMAGE_DEALT)).toBe(true);
    expect(registered.has("streaming:state:update")).toBe(true);

    system.destroy();

    expect(off).toHaveBeenCalledTimes(2);
    expect(off).toHaveBeenCalledWith(
      EventType.COMBAT_DAMAGE_DEALT,
      registered.get(EventType.COMBAT_DAMAGE_DEALT),
    );
    expect(off).toHaveBeenCalledWith(
      "streaming:state:update",
      registered.get("streaming:state:update"),
    );
  });
});
