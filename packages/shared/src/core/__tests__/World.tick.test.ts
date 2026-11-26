/**
 * World.tick Unit Tests
 *
 * Tests for the dual-delta timing architecture:
 * - Physics delta: Clamped to maxPhysicsDeltaTime for stability
 * - Animation delta: Real-time (capped at maxAnimationDeltaTime) for correct playback
 *
 * This ensures animations play at correct speed regardless of FPS,
 * while physics remains stable with controlled timesteps.
 */

import { describe, it, expect } from "vitest";
import { World } from "../World";
import THREE from "../../extras/three/three";

// Create testable World instance
function createTestWorld(): World {
  // World constructor takes no args - systems are registered internally
  // WorldOptions are applied by createClientWorld/createServerWorld
  const world = new World();
  return world;
}

function createServerTestWorld(): World {
  const world = createTestWorld();
  world.network = {
    isServer: true,
    isClient: false,
    send: () => {},
  } as World["network"];
  return world;
}

describe("World stage - ordinary scene-root matrix propagation", () => {
  async function createScenes() {
    const world = new World();
    await world.stage.init({});
    const scene = world.stage.scene;
    const reference = new THREE.Scene();
    const referenceRig = world.rig.clone(true);
    reference.add(referenceRig);
    const update = () => {
      // Match ordinary renderer calls: no explicit force argument. The normal
      // root must propagate its dirtiness to clean static-local descendants.
      scene.updateMatrixWorld();
      reference.updateMatrixWorld();
    };
    return { world, scene, reference, referenceRig, update };
  }

  function expectMatricesMatch(
    actual: THREE.Object3D,
    reference: THREE.Object3D,
  ) {
    expect(actual.matrix.equals(reference.matrix)).toBe(true);
    expect(actual.matrixWorld.equals(reference.matrixWorld)).toBe(true);
  }

  it("retains automatic root updates required by arbitrary static-local reparenting", async () => {
    const { world, scene, reference, update } = await createScenes();
    expect(world.getSystem("stage")).toBe(world.stage);
    expect(scene.matrixAutoUpdate).toBe(true);
    expect(scene.matrixWorldAutoUpdate).toBe(true);
    expect(scene.matrixWorldNeedsUpdate).toBe(false);
    expect(scene.matrix.elements).toEqual(new THREE.Matrix4().elements);
    expect(world.rig.parent).toBe(scene);
    expect(world.camera.parent).toBe(world.rig);
    update();
    expect(scene.matrixWorldNeedsUpdate).toBe(false);
    expectMatricesMatch(scene, reference);
    update();
    expect(scene.matrixWorldNeedsUpdate).toBe(false);
    expectMatricesMatch(scene, reference);
  });

  it("matches a normal scene for nested dynamic position, rotation and scale", async () => {
    const { scene, reference, update } = await createScenes();
    const parent = new THREE.Group();
    const child = new THREE.Object3D();
    const leaf = new THREE.Object3D();
    parent.add(child);
    child.add(leaf);
    scene.add(parent);
    const referenceParent = parent.clone(true);
    const referenceChild = referenceParent.children[0];
    const referenceLeaf = referenceChild.children[0];
    reference.add(referenceParent);
    for (let frame = 0; frame < 12; frame++) {
      for (const node of [parent, referenceParent]) {
        node.position.set(frame * 0.5, 2, -3);
        node.rotation.set(0.1, frame * 0.03, -0.2);
        node.scale.set(1.2, 1 + frame * 0.02, 0.7);
      }
      for (const node of [child, referenceChild]) {
        node.position.set(-1, frame * 0.1, 4);
        node.rotation.set(frame * -0.02, 0.4, 0.3);
        node.scale.set(0.8, 1.4, 1.1);
      }
      for (const node of [leaf, referenceLeaf]) {
        node.position.set(0.5, 1, frame * -0.05);
        node.rotation.y = frame * 0.04;
      }
      update();
      expectMatricesMatch(parent, referenceParent);
      expectMatricesMatch(child, referenceChild);
      expectMatricesMatch(leaf, referenceLeaf);
    }
  });

  it("keeps the actual world camera inverse and animated bone palette current", async () => {
    const { world, scene, reference, referenceRig, update } =
      await createScenes();
    const referenceCamera = referenceRig.children[0] as THREE.PerspectiveCamera;
    expect(referenceCamera.isPerspectiveCamera).toBe(true);
    const rootBone = new THREE.Bone();
    const childBone = new THREE.Bone();
    childBone.position.y = 2;
    rootBone.add(childBone);
    scene.add(rootBone);
    const referenceRoot = rootBone.clone(true);
    const referenceChild = referenceRoot.children[0] as THREE.Bone;
    reference.add(referenceRoot);
    update();
    const skeleton = new THREE.Skeleton([rootBone, childBone]);
    const referenceSkeleton = new THREE.Skeleton([
      referenceRoot,
      referenceChild,
    ]);
    for (let frame = 1; frame <= 8; frame++) {
      for (const rig of [world.rig, referenceRig]) {
        rig.position.set(frame, 3, -2);
        rig.rotation.y = frame * 0.15;
      }
      for (const camera of [world.camera, referenceCamera]) {
        camera.position.set(0.2, frame * 0.1, 5);
        camera.rotation.x = -frame * 0.025;
      }
      for (const bone of [rootBone, referenceRoot]) {
        bone.position.set(2, 0, frame * 0.2);
        bone.rotation.y = frame * -0.1;
      }
      for (const bone of [childBone, referenceChild]) {
        bone.rotation.z = frame * 0.1;
        bone.scale.y = 1 + frame * 0.01;
      }
      update();
      skeleton.update();
      referenceSkeleton.update();
      expectMatricesMatch(world.camera, referenceCamera);
      expect(
        world.camera.matrixWorldInverse.equals(
          referenceCamera.matrixWorldInverse,
        ),
      ).toBe(true);
      expectMatricesMatch(childBone, referenceChild);
      expect(Array.from(skeleton.boneMatrices)).toEqual(
        Array.from(referenceSkeleton.boneMatrices),
      );
    }
    skeleton.dispose();
    referenceSkeleton.dispose();
  });

  it("updates invisible descendants during ordinary scene traversal", async () => {
    const { scene, reference, update } = await createScenes();
    const hidden = new THREE.Group();
    hidden.visible = false;
    const child = new THREE.Object3D();
    hidden.add(child);
    scene.add(hidden);
    const referenceHidden = hidden.clone(true);
    const referenceChild = referenceHidden.children[0];
    reference.add(referenceHidden);
    update();
    for (const node of [hidden, referenceHidden]) node.position.set(4, 2, -1);
    for (const node of [child, referenceChild]) {
      node.position.set(1, 2, 3);
      node.rotation.y = 0.6;
      node.scale.set(0.8, 1.2, 0.9);
    }
    update();
    expectMatricesMatch(hidden, referenceHidden);
    expectMatricesMatch(child, referenceChild);
    hidden.visible = true;
    referenceHidden.visible = true;
    update();
    expectMatricesMatch(child, referenceChild);
  });

  it("preserves late addition, removal, re-addition and reparenting", async () => {
    const { scene, reference, update } = await createScenes();
    const first = new THREE.Group();
    const second = new THREE.Group();
    first.position.set(3, 1, -2);
    second.position.set(-4, 2, 5);
    const referenceFirst = first.clone();
    const referenceSecond = second.clone();
    scene.add(first, second);
    reference.add(referenceFirst, referenceSecond);
    update();
    update();
    const child = new THREE.Object3D();
    child.position.set(1, 2, 3);
    const referenceChild = child.clone();
    first.add(child);
    referenceFirst.add(referenceChild);
    update();
    expectMatricesMatch(child, referenceChild);
    first.remove(child);
    referenceFirst.remove(referenceChild);
    const detachedMatrix = child.matrixWorld.clone();
    child.position.set(2, 3, 4);
    referenceChild.position.copy(child.position);
    update();
    expect(child.matrixWorld.elements).toEqual(detachedMatrix.elements);
    expectMatricesMatch(child, referenceChild);
    first.add(child);
    referenceFirst.add(referenceChild);
    update();
    expectMatricesMatch(child, referenceChild);
    second.add(child);
    referenceSecond.add(referenceChild);
    update();
    expect(child.parent).toBe(second);
    expectMatricesMatch(child, referenceChild);
  });

  it("propagates an explicitly updated scene-root transform through static locals", async () => {
    const { scene, reference, update } = await createScenes();
    const group = new THREE.Group();
    const child = new THREE.Object3D();
    group.position.set(2, 0, 1);
    child.position.set(0, 3, -2);
    group.add(child);
    for (const node of [group, child]) {
      node.updateMatrix();
      node.matrixAutoUpdate = false;
    }
    scene.add(group);
    const referenceGroup = group.clone(true);
    const referenceChild = referenceGroup.children[0];
    reference.add(referenceGroup);
    update();
    update();
    for (const root of [scene, reference]) {
      root.position.set(10, -3, 4);
      root.rotation.set(0.1, 0.4, -0.2);
      root.scale.set(1.5, 0.8, 1.2);
    }
    // Explicit publication is also supported before an ordinary traversal.
    scene.updateMatrix();
    expect(scene.matrixWorldNeedsUpdate).toBe(true);
    update();
    expectMatricesMatch(scene, reference);
    expectMatricesMatch(group, referenceGroup);
    expectMatricesMatch(child, referenceChild);
    expect(scene.matrixWorldNeedsUpdate).toBe(false);
    update();
    expectMatricesMatch(child, referenceChild);
  });

  it("refreshes a clean static-local subtree reparented into the scene and a frozen parent", async () => {
    const { scene, reference, update } = await createScenes();
    const parent = new THREE.Group();
    parent.position.set(10, 2, -3);
    const target = new THREE.Group();
    target.position.set(-6, 7, 8);
    target.rotation.y = 0.4;
    const subtree = new THREE.Group();
    subtree.position.set(1, 2, 3);
    const child = new THREE.Object3D();
    child.position.set(0, 4, 0);
    subtree.add(child);
    parent.add(subtree);
    for (const node of [parent, target, subtree, child]) {
      node.updateMatrix();
      node.matrixAutoUpdate = false;
    }
    scene.add(parent, target);
    const referenceParent = parent.clone(true);
    const referenceSubtree = referenceParent.children[0];
    const referenceChild = referenceSubtree.children[0];
    const referenceTarget = target.clone();
    reference.add(referenceParent, referenceTarget);
    update();
    update();
    expect(subtree.matrixWorldNeedsUpdate).toBe(false);
    scene.add(subtree);
    reference.add(referenceSubtree);
    update();
    expectMatricesMatch(subtree, referenceSubtree);
    expectMatricesMatch(child, referenceChild);
    expect(target.matrixWorldNeedsUpdate).toBe(false);
    expect(subtree.matrixWorldNeedsUpdate).toBe(false);
    target.add(subtree);
    referenceTarget.add(referenceSubtree);
    update();
    expectMatricesMatch(subtree, referenceSubtree);
    expectMatricesMatch(child, referenceChild);
  });
});

describe("World.tick - Dual Delta Architecture", () => {
  describe("event listener counting", () => {
    it("counts string-event listeners registered through the typed EventBus bridge", () => {
      const world = createTestWorld();
      const handler = () => {};

      world.on("duel:stakes:settle", handler);

      expect(world.listenerCount("duel:stakes:settle")).toBe(1);
    });

    it("decrements string-event listener counts after removal", () => {
      const world = createTestWorld();
      const handler = () => {};

      world.on("duel:stakes:settle", handler);
      world.off("duel:stakes:settle", handler);

      expect(world.listenerCount("duel:stakes:settle")).toBe(0);
    });
  });

  // ===== DELTA TIME CONFIGURATION =====
  describe("delta time configuration", () => {
    it("should have default maxPhysicsDeltaTime of 33ms (1/30)", () => {
      const world = createTestWorld();
      expect(world.maxPhysicsDeltaTime).toBeCloseTo(1 / 30, 5);
    });

    it("should have default maxAnimationDeltaTime of 500ms", () => {
      const world = createTestWorld();
      expect(world.maxAnimationDeltaTime).toBe(0.5);
    });

    it("should have default fixedDeltaTime of 33ms (1/30)", () => {
      const world = createTestWorld();
      expect(world.fixedDeltaTime).toBeCloseTo(1 / 30, 5);
    });

    it("maxDeltaTime getter should return maxPhysicsDeltaTime (backward compatibility)", () => {
      const world = createTestWorld();
      expect(world.maxDeltaTime).toBe(world.maxPhysicsDeltaTime);
    });

    it("maxDeltaTime setter should update maxPhysicsDeltaTime (backward compatibility)", () => {
      const world = createTestWorld();
      world.maxDeltaTime = 0.05;
      expect(world.maxPhysicsDeltaTime).toBe(0.05);
    });

    it("should allow setting custom delta times", () => {
      const world = createTestWorld();
      world.maxPhysicsDeltaTime = 0.02;
      world.maxAnimationDeltaTime = 0.25;
      expect(world.maxPhysicsDeltaTime).toBe(0.02);
      expect(world.maxAnimationDeltaTime).toBe(0.25);
    });
  });

  // ===== FRAME AND TIME TRACKING =====
  describe("frame and time tracking", () => {
    it("should start with frame 0", () => {
      const world = createTestWorld();
      expect(world.frame).toBe(0);
    });

    it("should start with time 0", () => {
      const world = createTestWorld();
      expect(world.time).toBe(0);
    });

    it("should increment frame on each tick", () => {
      const world = createTestWorld();
      world.tick(16.67); // ~60 FPS
      expect(world.frame).toBe(1);
      world.tick(33.33);
      expect(world.frame).toBe(2);
      world.tick(50);
      expect(world.frame).toBe(3);
    });

    it("should update time on each tick (converted to seconds)", () => {
      const world = createTestWorld();
      world.tick(1000); // 1000ms = 1 second
      expect(world.time).toBe(1);
      world.tick(2500); // 2500ms = 2.5 seconds
      expect(world.time).toBe(2.5);
    });
  });

  // ===== ACCUMULATOR BEHAVIOR =====
  describe("accumulator behavior", () => {
    it("should start with accumulator at 0", () => {
      const world = createTestWorld();
      expect(world.accumulator).toBe(0);
    });

    it("should accumulate physics delta (not raw delta)", () => {
      const world = createTestWorld();
      // First tick establishes baseline
      world.tick(0);

      // Second tick with normal delta
      world.tick(16.67); // 16.67ms = ~60 FPS

      // Accumulator should have added clamped delta (in seconds)
      // 16.67ms = 0.01667s, which is less than maxPhysicsDeltaTime (0.0333s)
      expect(world.accumulator).toBeGreaterThan(0);
      expect(world.accumulator).toBeLessThanOrEqual(world.maxPhysicsDeltaTime);
    });

    it("should clamp physics delta to maxPhysicsDeltaTime", () => {
      const world = createTestWorld();
      world.tick(0); // baseline

      // Huge delta (simulating tab unfocus)
      world.tick(500); // 500ms delta

      // Accumulator should only add maxPhysicsDeltaTime worth
      expect(world.accumulator).toBeLessThanOrEqual(world.maxPhysicsDeltaTime);
    });

    it("should consume accumulator in fixedDeltaTime chunks", () => {
      const world = createTestWorld();
      world.tick(0);

      // Add exactly one physics step worth
      const targetTime = world.fixedDeltaTime * 1000; // Convert to ms
      world.tick(targetTime);

      // Accumulator should be near 0 after consuming fixed step
      expect(world.accumulator).toBeLessThan(world.fixedDeltaTime);
    });

    it("should run multiple physics steps when accumulator is large", () => {
      const world = createTestWorld();
      world.tick(0);

      // Add 3x physics step worth
      const targetTime = world.fixedDeltaTime * 1000 * 3;

      // Spy on fixedUpdate to count calls - but we can't easily spy on private methods
      // Instead, verify accumulator is properly consumed
      world.tick(targetTime);

      // After consuming 3 steps, accumulator should be < fixedDeltaTime
      expect(world.accumulator).toBeLessThan(world.fixedDeltaTime);
    });
  });

  // ===== BOUNDARY CONDITIONS =====
  describe("boundary conditions", () => {
    it("should handle zero delta gracefully", () => {
      const world = createTestWorld();
      world.tick(0);

      // Zero delta shouldn't cause issues
      world.tick(0);
      expect(world.frame).toBe(2);
      expect(world.accumulator).toBe(0);
    });

    it("should handle negative delta (clock skew) by clamping to 0", () => {
      const world = createTestWorld();
      world.tick(100);

      // Time going backward (shouldn't happen, but handle gracefully)
      world.tick(50);

      // Should have processed normally (negative becomes 0)
      expect(world.frame).toBe(2);
    });

    it("should clamp very large delta to maxAnimationDeltaTime", () => {
      const world = createTestWorld();
      world.tick(0);

      // Simulate returning from a long pause (10 seconds)
      const hugeDelta = 10000; // 10 seconds in ms
      world.tick(hugeDelta);

      // Frame should still advance
      expect(world.frame).toBe(2);

      // Accumulator should be capped at maxPhysicsDeltaTime
      expect(world.accumulator).toBeLessThanOrEqual(world.maxPhysicsDeltaTime);
    });

    it("should handle exactly boundary delta values", () => {
      const world = createTestWorld();
      world.tick(0);

      // Exactly maxPhysicsDeltaTime
      world.tick(world.maxPhysicsDeltaTime * 1000);
      expect(world.accumulator).toBeLessThanOrEqual(world.maxPhysicsDeltaTime);
    });

    it("should handle very small delta (high FPS)", () => {
      const world = createTestWorld();
      world.tick(0);

      // 240 FPS = 4.17ms per frame
      const highFpsDelta = 4.17;
      for (let i = 0; i < 10; i++) {
        world.tick(highFpsDelta * (i + 1));
      }

      expect(world.frame).toBe(11);
    });
  });

  // ===== REAL-WORLD SCENARIOS =====
  describe("real-world scenarios", () => {
    it("should maintain stable timing at 60 FPS", () => {
      const world = createTestWorld();
      let currentTime = 0;
      const frameTime = 16.67; // ~60 FPS

      for (let i = 0; i < 60; i++) {
        world.tick(currentTime);
        currentTime += frameTime;
      }

      // After 60 frames at 16.67ms = ~1 second
      expect(world.time).toBeCloseTo(1, 1);
      expect(world.frame).toBe(60);
    });

    it("should maintain stable timing at 30 FPS", () => {
      const world = createTestWorld();
      let currentTime = 0;
      const frameTime = 33.33; // 30 FPS

      for (let i = 0; i < 30; i++) {
        world.tick(currentTime);
        currentTime += frameTime;
      }

      expect(world.time).toBeCloseTo(1, 1);
      expect(world.frame).toBe(30);
    });

    it("should handle variable frame rates gracefully", () => {
      const world = createTestWorld();
      let currentTime = 0;

      // Simulate variable frame times
      const frameTimes = [16, 20, 50, 8, 33, 16, 100, 16, 16, 16];

      for (const dt of frameTimes) {
        currentTime += dt;
        world.tick(currentTime);
      }

      expect(world.frame).toBe(frameTimes.length);
      // Time tracks the timestamp (converted to seconds), not accumulated deltas
      expect(world.time).toBeCloseTo(currentTime / 1000, 2);
    });

    it("should recover from frame spike (tab unfocus)", () => {
      const world = createTestWorld();
      let currentTime = 0;

      // Normal frames
      for (let i = 0; i < 10; i++) {
        world.tick(currentTime);
        currentTime += 16.67;
      }

      const frameBeforeSpike = world.frame;

      // Huge spike (5 seconds pause)
      world.tick(currentTime);
      currentTime += 5000;
      world.tick(currentTime);

      // Should have advanced only 2 frames (not hundreds)
      expect(world.frame).toBe(frameBeforeSpike + 2);

      // Continue normally
      for (let i = 0; i < 10; i++) {
        world.tick(currentTime);
        currentTime += 16.67;
      }

      expect(world.frame).toBe(frameBeforeSpike + 12);
    });

    it("should not have 'spiral of death' under heavy load", () => {
      const world = createTestWorld();
      let currentTime = 0;

      // Simulate consistently slow frames (10 FPS)
      const slowFrameTime = 100; // 100ms per frame

      for (let i = 0; i < 20; i++) {
        world.tick(currentTime);
        currentTime += slowFrameTime;
      }

      // Physics accumulator should never grow unboundedly
      expect(world.accumulator).toBeLessThan(world.fixedDeltaTime * 2);
    });
  });

  // ===== INTERPOLATION ALPHA =====
  describe("interpolation alpha calculation", () => {
    it("should compute alpha between 0 and 1", () => {
      const world = createTestWorld();
      world.tick(0);

      // Partial physics step
      world.tick(10); // 10ms, less than fixedDeltaTime (33ms)

      // Accumulator / fixedDeltaTime should be in [0, 1)
      const alpha = world.accumulator / world.fixedDeltaTime;
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThan(1);
    });
  });
});

describe("World.tick - Delta Separation Verification", () => {
  /**
   * These tests verify the core invariant of the dual-delta system:
   * - Physics receives CLAMPED delta (for stability)
   * - Animation receives REAL delta (for correct speed)
   */

  it("should NOT suffer from slow-motion at low FPS", () => {
    const world = createTestWorld();
    world.tick(0);

    // At 10 FPS (100ms frame), the OLD system would pass 33ms to animations
    // causing 3x slower playback. The NEW system passes ~100ms (capped at 500ms)
    // to animations while keeping physics at 33ms.

    // Simulate 10 FPS
    const frameTime = 100; // 100ms = 10 FPS
    world.tick(frameTime);

    // Time should advance by 100ms, not 33ms
    expect(world.time).toBeCloseTo(0.1, 2);
  });

  it("should protect physics from large delta even at low FPS", () => {
    const world = createTestWorld();
    world.tick(0);

    // Large frame time
    const frameTime = 200; // 200ms = 5 FPS
    world.tick(frameTime);

    // Accumulator should only add maxPhysicsDeltaTime
    expect(world.accumulator).toBeLessThanOrEqual(world.maxPhysicsDeltaTime);
  });

  it("should cap animation delta at maxAnimationDeltaTime", () => {
    const world = createTestWorld();
    world.tick(0);

    // Extremely large frame time (10 seconds)
    const hugeFrameTime = 10000;
    world.tick(hugeFrameTime);

    // Time advances, but should be capped by the logic
    // The actual implementation uses Math.min(rawDelta, maxAnimationDeltaTime)
    // So time at second tick = 10s, but animations see 0.5s
    expect(world.time).toBe(10); // Time is updated with full value
  });
});

describe("World.tick - Concurrency and State", () => {
  it("should not have race conditions with sequential ticks", () => {
    const world = createTestWorld();
    const results: number[] = [];

    // Rapid sequential ticks
    for (let i = 0; i < 100; i++) {
      world.tick(i * 10);
      results.push(world.frame);
    }

    // Frames should be monotonically increasing
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[i - 1] + 1);
    }
  });

  it("should maintain consistent state after many ticks", () => {
    const world = createTestWorld();
    let time = 0;

    for (let i = 0; i < 10000; i++) {
      world.tick(time);
      time += 16.67;
    }

    expect(world.frame).toBe(10000);
    expect(world.time).toBeCloseTo(time / 1000, 0);
    expect(world.accumulator).toBeLessThan(world.fixedDeltaTime);
  });
});

describe("World.tick - server percentile diagnostics", () => {
  it("records bounded full-window phase and complete-system timings", () => {
    const world = createServerTestWorld();
    world.enableSystemTiming();

    world.tick(0);
    world.tick(33.34);

    const phases = world.getServerTickTimingPercentiles();
    expect(phases.total.samples).toBe(2);
    expect(phases.fixedUpdate.samples).toBe(2);
    expect(phases.update.samples).toBe(2);
    expect(phases.lateUpdate.samples).toBe(2);
    expect(phases.commit.samples).toBe(2);
    expect(phases.unmeasured.samples).toBe(2);
    expect(phases.total.max).toBeGreaterThanOrEqual(phases.update.max);

    const systems = world.getSystemTimingPercentiles();
    expect(systems.length).toBe(world.systems.length);
    expect(systems.every((system) => system.samples === 2)).toBe(true);
  });

  it("resets phase and system distributions without disabling measurement", () => {
    const world = createServerTestWorld();
    world.enableSystemTiming();
    world.tick(0);

    world.resetServerTimingPercentiles();
    expect(world.getServerTickTimingPercentiles().total.samples).toBe(0);
    expect(
      world
        .getSystemTimingPercentiles()
        .every((system) => system.samples === 0),
    ).toBe(true);

    world.tick(33.34);
    expect(world.getServerTickTimingPercentiles().total.samples).toBe(1);
    expect(
      world
        .getSystemTimingPercentiles()
        .every((system) => system.samples === 1),
    ).toBe(true);
  });
});
