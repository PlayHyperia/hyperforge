import { createHash } from "node:crypto";

import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { TileInterpolator } from "../TileInterpolator";

function createRenderedEntity(position = new THREE.Vector3()) {
  const data: Record<string, unknown> = {};
  return {
    position: position.clone(),
    node: new THREE.Object3D(),
    base: new THREE.Object3D(),
    data,
    modify: vi.fn((changes: Record<string, unknown>) => {
      Object.assign(data, changes);
    }),
  };
}

function yaw(radians: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    radians,
  );
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function timelineHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function runMovementAndCombatTurnTimeline(fps: 30 | 60) {
  const interpolator = new TileInterpolator();
  const entity = createRenderedEntity(new THREE.Vector3(0.5, 0, 0.5));
  const frameSeconds = 1 / fps;
  const trace: unknown[] = [];
  let previousPosition = entity.position.clone();
  let previousRotation = entity.base.quaternion.clone();
  let maximumVisualStep = 0;
  let maximumAngularVelocity = 0;
  let movementCompleted = false;

  interpolator.setCombatRotation("fighter", yaw(0), entity.position);
  interpolator.update(frameSeconds, () => entity);
  interpolator.onMovementStart(
    "fighter",
    [
      { x: 1, z: 1 },
      { x: 2, z: 2 },
      { x: 3, z: 2 },
      { x: 4, z: 1 },
      { x: 4, z: 0 },
    ],
    false,
    entity.position,
    { x: 0, z: 0 },
    { x: 4, z: 0 },
    1,
  );

  const captureFrame = (frame: number, phase: "movement" | "combat") => {
    const visualStep = entity.position.distanceTo(previousPosition);
    const rotationStep = entity.base.quaternion.angleTo(previousRotation);
    maximumVisualStep = Math.max(maximumVisualStep, visualStep);
    maximumAngularVelocity = Math.max(
      maximumAngularVelocity,
      rotationStep / frameSeconds,
    );
    expect(Number.isFinite(visualStep)).toBe(true);
    expect(Number.isFinite(rotationStep)).toBe(true);
    expect(rounded(entity.base.quaternion.length())).toBe(1);
    if (frame % Math.max(1, Math.floor(fps / 10)) === 0) {
      trace.push({
        phase,
        frame,
        position: [rounded(entity.position.x), rounded(entity.position.z)],
        quaternion: [
          rounded(entity.base.quaternion.x),
          rounded(entity.base.quaternion.y),
          rounded(entity.base.quaternion.z),
          rounded(entity.base.quaternion.w),
        ],
        moving: entity.data.tileMovementActive === true,
      });
    }
    previousPosition.copy(entity.position);
    previousRotation.copy(entity.base.quaternion);
  };

  for (let frame = 1; frame <= fps * 2; frame++) {
    interpolator.update(
      frameSeconds,
      () => entity,
      undefined,
      () => {
        movementCompleted = true;
      },
    );
    captureFrame(frame, "movement");
  }

  const combatTarget = yaw(Math.PI * 0.8);
  const rotationBeforeTargetChange = entity.base.quaternion.clone();
  const fullTargetTurn = rotationBeforeTargetChange.angleTo(combatTarget);
  expect(
    interpolator.setCombatRotation("fighter", combatTarget, entity.position),
  ).toBe(true);
  interpolator.update(frameSeconds, () => entity);
  const firstTargetTurnStep = entity.base.quaternion.angleTo(
    rotationBeforeTargetChange,
  );
  captureFrame(0, "combat");

  for (let frame = 1; frame <= fps * 2; frame++) {
    interpolator.update(frameSeconds, () => entity);
    captureFrame(frame, "combat");
  }

  return {
    fps,
    hash: timelineHash(trace),
    movementCompleted,
    finalPosition: [rounded(entity.position.x), rounded(entity.position.z)],
    finalFacingError: rounded(entity.base.quaternion.angleTo(combatTarget)),
    fullTargetTurn: rounded(fullTargetTurn),
    firstTargetTurnStep: rounded(firstTargetTurnStep),
    maximumVisualStep: rounded(maximumVisualStep),
    maximumAngularVelocity: rounded(maximumAngularVelocity),
  };
}

describe("TileInterpolator combat rotation", () => {
  it("smoothly turns a stationary fighter after a target-side change", () => {
    const interpolator = new TileInterpolator();
    const entity = createRenderedEntity();
    const initial = yaw(0);
    const target = yaw(Math.PI);

    expect(
      interpolator.setCombatRotation("fighter", initial, entity.position),
    ).toBe(true);
    interpolator.update(1 / 60, () => entity);
    expect(entity.base.quaternion.angleTo(initial)).toBeLessThan(1e-6);

    expect(
      interpolator.setCombatRotation("fighter", target, entity.position),
    ).toBe(true);
    interpolator.update(1 / 60, () => entity);

    expect(entity.base.quaternion.angleTo(initial)).toBeGreaterThan(0.04);
    expect(entity.base.quaternion.angleTo(target)).toBeGreaterThan(0.1);

    for (let frame = 0; frame < 90; frame += 1) {
      interpolator.update(1 / 60, () => entity);
    }
    expect(entity.base.quaternion.angleTo(target)).toBeLessThan(0.001);
  });

  it("bounds a full opponent-side reversal without losing responsive facing", () => {
    const interpolator = new TileInterpolator();
    const entity = createRenderedEntity();
    const initial = yaw(0);
    const target = yaw(Math.PI);

    interpolator.setCombatRotation("fighter", initial, entity.position);
    interpolator.update(1 / 60, () => entity);
    interpolator.setCombatRotation("fighter", target, entity.position);

    for (let frame = 0; frame < 19; frame += 1) {
      interpolator.update(1 / 60, () => entity);
    }

    const turnDegrees = THREE.MathUtils.radToDeg(
      entity.base.quaternion.angleTo(initial),
    );
    const facingErrorDegrees = THREE.MathUtils.radToDeg(
      entity.base.quaternion.angleTo(target),
    );
    expect(turnDegrees).toBeLessThanOrEqual(120);
    expect(facingErrorDegrees).toBeLessThanOrEqual(75);
  });

  it("uses equivalent damping at 30 and 60 frames per second", () => {
    const target = yaw(Math.PI * 0.75);
    const run = (fps: number) => {
      const interpolator = new TileInterpolator();
      const entity = createRenderedEntity();
      interpolator.setCombatRotation("fighter", yaw(0), entity.position);
      interpolator.setCombatRotation("fighter", target, entity.position);
      for (let frame = 0; frame < fps; frame += 1) {
        interpolator.update(1 / fps, () => entity);
      }
      return entity.base.quaternion.clone();
    };

    expect(run(30).angleTo(run(60))).toBeLessThan(0.0001);
  });

  it("moves through a diagonal path and turns without a visual snap", () => {
    const interpolator = new TileInterpolator();
    const entity = createRenderedEntity();
    const initial = yaw(0);

    interpolator.setCombatRotation("fighter", initial, entity.position);
    interpolator.clearCombatRotation("fighter");
    interpolator.onMovementStart(
      "fighter",
      [{ x: 1, z: 1 }],
      false,
      entity.position,
      { x: 0, z: 0 },
      { x: 1, z: 1 },
      1,
    );
    interpolator.update(1 / 60, () => entity);

    expect(entity.position.x).toBeGreaterThan(0);
    expect(entity.position.z).toBeGreaterThan(0);
    expect(entity.base.quaternion.angleTo(initial)).toBeGreaterThan(0.04);
    expect(
      entity.base.quaternion.angleTo(yaw(-Math.PI * 0.75)),
    ).toBeGreaterThan(0.1);
  });

  it("keeps combat-facing ownership while a fighter kites diagonally", () => {
    const interpolator = new TileInterpolator();
    const entity = createRenderedEntity(new THREE.Vector3(0.5, 0, 0.5));
    const combatTarget = yaw(Math.PI);

    interpolator.onMovementStart(
      "fighter",
      [
        { x: 1, z: 1 },
        { x: 2, z: 2 },
      ],
      false,
      entity.position,
      { x: 0, z: 0 },
      { x: 2, z: 2 },
      1,
    );
    const before = entity.base.quaternion.angleTo(combatTarget);

    expect(
      interpolator.setCombatRotation("fighter", combatTarget, entity.position),
    ).toBe(true);
    for (let frame = 0; frame < 20; frame += 1) {
      interpolator.update(1 / 60, () => entity);
    }

    expect(entity.position.x).toBeGreaterThan(0.5);
    expect(entity.position.z).toBeGreaterThan(0.5);
    expect(entity.base.quaternion.angleTo(combatTarget)).toBeLessThan(before);
    expect(entity.base.quaternion.angleTo(combatTarget)).toBeLessThan(0.1);
  });

  it("does not yield combat facing for a frame when a new strafe segment begins", () => {
    const interpolator = new TileInterpolator();
    const entity = createRenderedEntity(new THREE.Vector3(0.5, 0, 0.5));
    const opponentFacing = yaw(0);

    interpolator.setCombatRotation("fighter", opponentFacing, entity.position);
    interpolator.update(1 / 60, () => entity);
    interpolator.onMovementStart(
      "fighter",
      [
        { x: 1, z: 1 },
        { x: 2, z: 2 },
      ],
      false,
      entity.position,
      { x: 0, z: 0 },
      { x: 2, z: 2 },
      1,
    );
    interpolator.update(1 / 60, () => entity);

    expect(entity.base.quaternion.angleTo(opponentFacing)).toBeLessThan(1e-6);

    interpolator.clearCombatRotation("fighter");
    interpolator.onMovementStart(
      "fighter",
      [{ x: -1, z: 1 }],
      false,
      entity.position,
      { x: 1, z: 1 },
      { x: -1, z: 1 },
      2,
    );
    interpolator.update(1 / 60, () => entity);

    expect(entity.base.quaternion.angleTo(opponentFacing)).toBeGreaterThan(
      0.04,
    );
  });

  it("keeps a locked duel target authoritative over generic rotation packets", () => {
    const interpolator = new TileInterpolator();
    const entity = createRenderedEntity(new THREE.Vector3(0.5, 0, 0.5));
    const opponentFacing = yaw(Math.PI * 0.25);
    const conflictingServerRotation = yaw(-Math.PI * 0.75);

    interpolator.setCombatRotation(
      "fighter",
      opponentFacing,
      entity.position,
      true,
    );
    interpolator.update(1 / 60, () => entity);
    interpolator.setCombatRotation(
      "fighter",
      conflictingServerRotation,
      entity.position,
    );
    for (let frame = 0; frame < 30; frame += 1) {
      interpolator.update(1 / 60, () => entity);
    }
    expect(entity.base.quaternion.angleTo(opponentFacing)).toBeLessThan(1e-6);

    interpolator.clearCombatRotation("fighter");
    interpolator.setCombatRotation(
      "fighter",
      conflictingServerRotation,
      entity.position,
    );
    for (let frame = 0; frame < 60; frame += 1) {
      interpolator.update(1 / 60, () => entity);
    }
    expect(
      entity.base.quaternion.angleTo(conflictingServerRotation),
    ).toBeLessThan(0.2);
    for (let frame = 0; frame < 30; frame += 1) {
      interpolator.update(1 / 60, () => entity);
    }
    expect(
      entity.base.quaternion.angleTo(conflictingServerRotation),
    ).toBeLessThan(0.001);
  });

  it("retains a bounded 30/60 FPS movement-to-combat rotation time series", () => {
    const thirty = runMovementAndCombatTurnTimeline(30);
    const sixty = runMovementAndCombatTurnTimeline(60);

    expect(runMovementAndCombatTurnTimeline(30)).toEqual(thirty);
    expect(runMovementAndCombatTurnTimeline(60)).toEqual(sixty);
    expect(thirty.hash).toBe(
      "d01d1e78e97e5351397745a4ea4086073ec2520cf8e80d7e257cda26dda84352",
    );
    expect(sixty.hash).toBe(
      "bde78c4d680be71b92e9bf469b41b0225529e00ccb284e10559b2fce1dde0b57",
    );
    expect(thirty.movementCompleted).toBe(true);
    expect(sixty.movementCompleted).toBe(true);
    expect(thirty.finalPosition).toEqual([4.5, 0.5]);
    expect(sixty.finalPosition).toEqual(thirty.finalPosition);
    expect(thirty.firstTargetTurnStep).toBeGreaterThan(0);
    expect(thirty.firstTargetTurnStep).toBeLessThan(thirty.fullTargetTurn);
    expect(sixty.firstTargetTurnStep).toBeGreaterThan(0);
    expect(sixty.firstTargetTurnStep).toBeLessThan(sixty.fullTargetTurn);
    expect(thirty.finalFacingError).toBeLessThanOrEqual(0.000001);
    expect(sixty.finalFacingError).toBeLessThanOrEqual(0.000001);
    // Large turns are capped at 5.85 rad/s while small tracking corrections retain
    // the responsive exponential damping path.
    expect(thirty.maximumAngularVelocity).toBeLessThanOrEqual(5.850001);
    expect(sixty.maximumAngularVelocity).toBeLessThanOrEqual(5.850001);
    expect(thirty.maximumVisualStep).toBeLessThanOrEqual(2 / 18 + 0.000001);
    expect(sixty.maximumVisualStep).toBeLessThanOrEqual(2 / 36 + 0.000001);
  });
});
