import { describe, expect, it, vi } from "vitest";

import * as THREE from "../../../extras/three/three";
import { EventType } from "../../../types/events";
import type { World } from "../../../types";
import { ClientNetwork } from "../ClientNetwork";

function createEntity(id: string, x: number, z: number) {
  const data: Record<string, unknown> = {};
  return {
    id,
    position: new THREE.Vector3(x, 0, z),
    node: new THREE.Object3D(),
    base: new THREE.Object3D(),
    avatar: { clearHitReaction: vi.fn() },
    data,
    modify: vi.fn((changes: Record<string, unknown>) => {
      Object.assign(data, changes);
    }),
  };
}

function facingQuaternion(
  player: { position: THREE.Vector3 },
  target: { position: THREE.Vector3 },
) {
  const dx = target.position.x - player.position.x;
  const dz = target.position.z - player.position.z;
  return new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.atan2(dx, dz) + Math.PI,
  );
}

function createWorld(entities: Map<string, ReturnType<typeof createEntity>>) {
  return {
    emit: vi.fn(),
    entities: {
      get: (id: string) => entities.get(id) ?? null,
      player: undefined,
    },
    getSystem: vi.fn(() => null),
    frameBudget: null,
  } as unknown as World;
}

describe("ClientNetwork authoritative combat facing", () => {
  it("retries processing-source facing after out-of-order entity creation", () => {
    const entities = new Map<string, ReturnType<typeof createEntity>>();
    const world = createWorld(entities);
    const network = new ClientNetwork(world);
    network.onProcessingInteractionPresentation({
      playerId: "cook",
      revision: 1,
      skill: "cooking",
      phase: "working",
      phaseStartedAtServerTimeMs: 1000,
      targetPosition: { x: 4.5, y: 0, z: 3.5 },
    });

    const cook = createEntity("cook", 0.5, 0.5);
    entities.set(cook.id, cook);
    network.lateUpdate(1 / 60);
    const target = { position: new THREE.Vector3(4.5, 0, 3.5) };
    expect(
      cook.base.quaternion.angleTo(facingQuaternion(cook, target)),
    ).toBeLessThan(1e-6);
  });

  it("does not let processing cleanup release an active combat-facing owner", () => {
    const fighter = createEntity("fighter", 0.5, 0.5);
    const target = createEntity("target", 0.5, 5.5);
    const entities = new Map([
      [fighter.id, fighter],
      [target.id, target],
    ]);
    const world = createWorld(entities);
    const network = new ClientNetwork(world);
    const clear = vi.spyOn(network.tileInterpolator, "clearCombatRotation");
    network.onCombatFaceTarget({ playerId: fighter.id, targetId: target.id });
    network.onProcessingInteractionPresentation({
      playerId: fighter.id,
      revision: 2,
      skill: "smithing",
      phase: "working",
      phaseStartedAtServerTimeMs: 2000,
      targetPosition: { x: 4, y: 0, z: 0 },
    });
    network.onProcessingInteractionPresentation({
      playerId: fighter.id,
      revision: 3,
      skill: null,
      phase: "idle",
      phaseStartedAtServerTimeMs: null,
      targetPosition: null,
    });

    expect(clear).not.toHaveBeenCalledWith(fighter.id);
    network.lateUpdate(1 / 60);
    expect(
      fighter.base.quaternion.angleTo(facingQuaternion(fighter, target)),
    ).toBeLessThan(1e-6);
  });

  it("renders an anonymous spectator's remote fighter toward its authoritative target", () => {
    const fighter = createEntity("ranger", 0.5, 0.5);
    const target = createEntity("melee", 0.5, 5.5);
    const entities = new Map([
      [fighter.id, fighter],
      [target.id, target],
    ]);
    const world = createWorld(entities);
    const network = new ClientNetwork(world);

    network.onCombatFaceTarget({
      playerId: fighter.id,
      targetId: target.id,
    });
    network.lateUpdate(1 / 60);

    expect(
      fighter.base.quaternion.angleTo(facingQuaternion(fighter, target)),
    ).toBeLessThan(1e-6);
    expect(world.emit).toHaveBeenCalledWith(EventType.COMBAT_FACE_TARGET, {
      playerId: fighter.id,
      targetId: target.id,
    });
  });

  it("retries out-of-order target packets and tracks a moving opponent while kiting diagonally", () => {
    const entities = new Map<string, ReturnType<typeof createEntity>>();
    const world = createWorld(entities);
    const network = new ClientNetwork(world);

    network.onCombatFaceTarget({
      playerId: "ranger",
      targetId: "melee",
    });

    const fighter = createEntity("ranger", 0.5, 0.5);
    const target = createEntity("melee", 0.5, 5.5);
    entities.set(fighter.id, fighter);
    entities.set(target.id, target);
    network.onTileMovementStart({
      id: fighter.id,
      startTile: { x: 0, z: 0 },
      path: [
        { x: 1, z: 1 },
        { x: 2, z: 2 },
      ],
      destinationTile: { x: 2, z: 2 },
      running: false,
      moveSeq: 1,
    });

    for (let frame = 0; frame < 45; frame += 1) {
      if (frame === 20) target.position.set(-4.5, 0, 3.5);
      network.lateUpdate(1 / 60);
    }

    expect(fighter.position.x).toBeGreaterThan(0.5);
    expect(fighter.position.z).toBeGreaterThan(0.5);
    expect(
      fighter.base.quaternion.angleTo(facingQuaternion(fighter, target)),
      // The target quaternion is sampled before this frame's movement and then
      // approached with bounded slerp, so a moving fighter intentionally trails
      // the exact post-frame bearing by less than eight degrees.
    ).toBeLessThan(THREE.MathUtils.degToRad(8));
  });

  it("releases combat-facing ownership on explicit clear and terminal cleanup", () => {
    const fighter = createEntity("ranger", 0.5, 0.5);
    const target = createEntity("melee", 0.5, 5.5);
    const entities = new Map([
      [fighter.id, fighter],
      [target.id, target],
    ]);
    const world = createWorld(entities);
    const network = new ClientNetwork(world);
    const clear = vi.spyOn(network.tileInterpolator, "clearCombatRotation");

    network.onCombatFaceTarget({
      playerId: fighter.id,
      targetId: target.id,
    });
    network.onCombatClearFaceTarget({ playerId: fighter.id });
    network.onCombatEnded({ attackerId: fighter.id, targetId: target.id });

    expect(clear).toHaveBeenCalledWith(fighter.id);
    expect(clear).toHaveBeenCalledWith(target.id);
    expect(world.emit).toHaveBeenCalledWith(
      EventType.COMBAT_CLEAR_FACE_TARGET,
      { playerId: fighter.id },
    );
    expect(world.emit).toHaveBeenCalledWith(EventType.COMBAT_ENDED, {
      attackerId: fighter.id,
      targetId: target.id,
    });
  });

  it("locks the staged stream pair through combat and releases it at resolution", () => {
    const fighter = createEntity("ranger", 0.5, 0.5);
    const target = createEntity("melee", 0.5, 5.5);
    const decoy = createEntity("decoy", -10.5, -10.5);
    const entities = new Map([
      [fighter.id, fighter],
      [target.id, target],
      [decoy.id, decoy],
    ]);
    const world = createWorld(entities);
    const network = new ClientNetwork(world);
    const clear = vi.spyOn(network.tileInterpolator, "clearCombatRotation");
    const streamState = (
      phase: "ANNOUNCEMENT" | "COUNTDOWN" | "FIGHTING" | "RESOLUTION",
    ) => ({
      type: "STREAMING_STATE_UPDATE",
      cycle: {
        cycleId: "cycle-a",
        phase,
        cycleStartTime: 0,
        phaseStartTime: 0,
        phaseEndTime: 1,
        timeRemaining: 1,
        agent1: { id: fighter.id },
        agent2: { id: target.id },
        countdown: null,
        fightStartTime: 0,
        arenaPositions: null,
        winnerId: null,
        winnerName: null,
        outcome: null,
        winReason: null,
      },
      leaderboard: [],
      cameraTarget: null,
    });

    network.onStreamingState(streamState("ANNOUNCEMENT"));
    for (let frame = 0; frame < 120; frame += 1) {
      network.lateUpdate(1 / 60);
    }
    expect(
      fighter.base.quaternion.angleTo(facingQuaternion(fighter, target)),
    ).toBeLessThan(1e-6);
    expect(fighter.avatar.clearHitReaction).not.toHaveBeenCalled();
    expect(target.avatar.clearHitReaction).not.toHaveBeenCalled();

    network.onStreamingState(streamState("COUNTDOWN"));
    expect(
      fighter.base.quaternion.angleTo(facingQuaternion(fighter, target)),
    ).toBeLessThan(1e-6);

    network.onStreamingState(streamState("FIGHTING"));
    network.onCombatFaceTarget({ playerId: fighter.id, targetId: decoy.id });
    network.onCombatClearFaceTarget({ playerId: fighter.id });
    network.onCombatEnded({ attackerId: fighter.id, targetId: target.id });
    target.position.set(5.5, 0, 0.5);
    network.lateUpdate(1 / 60);

    expect(clear).not.toHaveBeenCalledWith(fighter.id);
    expect(world.emit).toHaveBeenCalledWith(EventType.COMBAT_FACE_TARGET, {
      playerId: fighter.id,
      targetId: target.id,
    });
    expect(
      fighter.base.quaternion.angleTo(facingQuaternion(fighter, target)),
    ).toBeLessThan(THREE.MathUtils.degToRad(75));

    network.onStreamingState(streamState("RESOLUTION"));
    expect(clear).toHaveBeenCalledWith(fighter.id);
    expect(clear).toHaveBeenCalledWith(target.id);
    expect(fighter.avatar.clearHitReaction).toHaveBeenCalledOnce();
    expect(target.avatar.clearHitReaction).toHaveBeenCalledOnce();
  });

  it("restores frozen duel-facing before a recreated movement state can adopt its travel heading", () => {
    const fighter = createEntity("ranger", 0.5, 0.5);
    const target = createEntity("melee", 0.5, 5.5);
    const entities = new Map([
      [fighter.id, fighter],
      [target.id, target],
    ]);
    const network = new ClientNetwork(createWorld(entities));

    network.onStreamingState({
      type: "STREAMING_STATE_UPDATE",
      cycle: {
        cycleId: "cycle-recreated-state",
        phase: "FIGHTING",
        cycleStartTime: 0,
        phaseStartTime: 0,
        phaseEndTime: 1,
        timeRemaining: 1,
        agent1: { id: fighter.id },
        agent2: { id: target.id },
        countdown: null,
        fightStartTime: 0,
        arenaPositions: null,
        winnerId: null,
        winnerName: null,
        outcome: null,
        winReason: null,
      },
      leaderboard: [],
      cameraTarget: null,
    });

    // Reproduce lifecycle cleanup immediately before a diagonal path packet.
    // Without synchronous re-locking, onMovementStart initializes the rendered
    // quaternion toward this path (east) instead of the opponent (south).
    network.tileInterpolator.removeEntity(fighter.id);
    network.onTileMovementStart({
      id: fighter.id,
      startTile: { x: 0, z: 0 },
      path: [{ x: 1, z: 0 }],
      destinationTile: { x: 1, z: 0 },
      running: false,
      moveSeq: 1,
      emote: "walk",
    });
    network.lateUpdate(1 / 60);

    expect(
      fighter.base.quaternion.angleTo(facingQuaternion(fighter, target)),
    ).toBeLessThan(THREE.MathUtils.degToRad(1));
  });
});
