import { afterEach, describe, expect, it, vi } from "vitest";

import THREE from "../../../extras/three/three";
import { ProjectileRenderer } from "../ProjectileRenderer";

type ProjectileRendererInternals = {
  activeProjectiles: Array<{
    sprite: THREE.Object3D;
    projectileId?: string;
    travelDurationMs?: number;
  }>;
  arrowGeometryCache: Map<
    string,
    {
      shaft: THREE.BufferGeometry;
      head: THREE.BufferGeometry;
      fletching: THREE.BufferGeometry;
    }
  >;
  onProjectileLaunched: (data: unknown) => void;
  onProjectileHit: (data: unknown) => void;
  onProjectileCancelled: (data: unknown) => void;
  onCombatEnded: (data: unknown) => void;
  releaseDelayedArrow: (
    networkEventId: string,
    drawHandWorldPosition: readonly [number, number, number],
  ) => boolean;
};

function createRenderer(
  attackerEntity: unknown = null,
  equipmentVisual?: unknown,
): {
  renderer: ProjectileRenderer;
  internals: ProjectileRendererInternals;
} {
  const world = {
    isClient: true,
    stage: { scene: new THREE.Scene() },
    entities: {
      get: vi.fn((id: string) => (id === "ranger" ? attackerEntity : null)),
    },
    camera: new THREE.PerspectiveCamera(),
    getSystem: vi.fn((name: string) =>
      name === "equipment-visual" ? equipmentVisual : undefined,
    ),
    on: vi.fn(),
    off: vi.fn(),
  };
  const renderer = new ProjectileRenderer(world as never);
  return {
    renderer,
    internals: renderer as unknown as ProjectileRendererInternals,
  };
}

const launch = {
  projectileId: "projectile-default",
  attackerId: "ranger",
  targetId: "mage",
  projectileType: "arrow",
  sourcePosition: { x: 0, y: 0, z: 0 },
  targetPosition: { x: 6, y: 0, z: 0 },
  arrowId: "rune_arrow",
  travelDurationMs: 600,
};

const impact = {
  projectileId: "projectile-default",
  attackerId: "ranger",
  targetId: "mage",
  damage: 7,
  projectileType: "arrow",
  position: { x: 6, y: 0, z: 0 },
  networkEventId: "server-a:impact-default",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ProjectileRenderer authoritative timing", () => {
  it("keeps the visual in flight until the server-derived duration", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const { renderer, internals } = createRenderer();

    internals.onProjectileLaunched(launch);
    expect(internals.activeProjectiles).toHaveLength(1);
    expect(internals.activeProjectiles[0].travelDurationMs).toBe(600);

    now.mockReturnValue(300);
    renderer.update(0.3);
    expect(internals.activeProjectiles).toHaveLength(1);

    now.mockReturnValue(599);
    renderer.update(0.299);
    expect(internals.activeProjectiles).toHaveLength(1);

    now.mockReturnValue(600);
    renderer.update(0.001);
    expect(internals.activeProjectiles).toHaveLength(1);
    expect(internals.activeProjectiles[0].sprite.visible).toBe(false);

    now.mockReturnValue(13_499);
    renderer.update(12.899);
    expect(internals.activeProjectiles).toHaveLength(1);

    now.mockReturnValue(13_500);
    renderer.update(0.001);
    expect(internals.activeProjectiles).toHaveLength(0);
    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowImpactEventCount: 0,
      arrowExpiredBeforeImpactCount: 1,
    });
  });

  it("removes the visual on the authoritative impact event", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const { renderer, internals } = createRenderer();
    internals.onProjectileLaunched(launch);

    now.mockReturnValue(250);
    internals.onProjectileHit(impact);
    renderer.update(0.25);

    expect(internals.activeProjectiles).toHaveLength(0);
    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowImpactEventCount: 1,
      arrowExpiredBeforeImpactCount: 0,
      recentArrowImpacts: [
        {
          projectileId: "projectile-default",
          damage: 7,
          visualFound: true,
          impactParticleCount: 7,
        },
      ],
    });
  });

  it("keeps an arrived arrow addressable for a delayed authoritative impact", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const { renderer, internals } = createRenderer();
    internals.onProjectileLaunched(launch);

    now.mockReturnValue(2_000);
    renderer.update(2);
    expect(internals.activeProjectiles).toHaveLength(1);
    expect(internals.activeProjectiles[0].sprite.visible).toBe(false);

    internals.onProjectileHit(impact);
    renderer.update(0);

    expect(internals.activeProjectiles).toHaveLength(0);
    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowImpactEventCount: 1,
      arrowExpiredBeforeImpactCount: 0,
      recentArrowImpacts: [
        {
          projectileId: "projectile-default",
          visualFound: true,
        },
      ],
    });
  });

  it("removes only the exact visual on authoritative cancellation", () => {
    vi.spyOn(performance, "now").mockReturnValue(250);
    const { renderer, internals } = createRenderer();
    internals.onProjectileLaunched({
      ...launch,
      projectileId: "projectile-cancelled",
      networkEventId: "server-a:launch-cancelled",
    });
    internals.onProjectileLaunched({
      ...launch,
      projectileId: "projectile-survives",
      networkEventId: "server-a:launch-survives",
    });

    internals.onProjectileCancelled({
      projectileId: "projectile-cancelled",
      attackerId: "ranger",
      targetId: "mage",
      projectileType: "arrow",
      reason: "entity_died",
      networkEventId: "server-a:cancel-cancelled",
    });

    expect(
      internals.activeProjectiles.map((projectile) => projectile.projectileId),
    ).toEqual(["projectile-survives"]);
    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowCancellationEventCount: 1,
      arrowExpiredBeforeImpactCount: 0,
      recentArrowCancellations: [
        {
          projectileId: "projectile-cancelled",
          launchNetworkEventId: "server-a:launch-cancelled",
          networkEventId: "server-a:cancel-cancelled",
          reason: "entity_died",
          visualFound: true,
        },
      ],
    });
  });

  it("retires an exact delayed draw before it creates a ghost arrow", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(10);
    const cancelCommittedArrow = vi.fn().mockReturnValue(true);
    const { renderer, internals } = createRenderer(null, {
      cancelCommittedArrow,
    });
    internals.onProjectileLaunched({
      ...launch,
      projectileId: "projectile-cancelled-before-release",
      delayMs: 400,
      networkEventId: "server-a:launch-before-release",
    });

    internals.onProjectileCancelled({
      projectileId: "projectile-cancelled-before-release",
      attackerId: "ranger",
      targetId: "mage",
      projectileType: "arrow",
      reason: "combat_ended",
      networkEventId: "server-a:cancel-before-release",
    });
    vi.advanceTimersByTime(1_000);

    expect(cancelCommittedArrow).toHaveBeenCalledWith(
      "ranger",
      "server-a:launch-before-release",
    );
    expect(internals.activeProjectiles).toHaveLength(0);
    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowSpawnCount: 0,
      arrowCancelledBeforeSpawnCount: 0,
      arrowCancellationEventCount: 1,
      pendingArrowCount: 0,
      recentArrowCancellations: [
        {
          projectileId: "projectile-cancelled-before-release",
          launchSequence: null,
          visualFound: true,
        },
      ],
    });
  });

  it("does not let a pair-wide combat end cancel a committed projectile ID", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const { renderer, internals } = createRenderer();

    internals.onProjectileLaunched({
      ...launch,
      projectileId: "projectile-next-cycle",
      delayMs: 300,
    });
    internals.onCombatEnded({ attackerId: "ranger", targetId: "mage" });
    vi.advanceTimersByTime(500);

    expect(internals.activeProjectiles).toHaveLength(1);
    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowSpawnCount: 1,
      arrowCancelledBeforeSpawnCount: 0,
      pendingArrowCount: 0,
      activeArrows: [{ projectileId: "projectile-next-cycle" }],
    });
  });

  it("rejects non-finite timing instead of creating a ghost projectile", () => {
    const { internals } = createRenderer();

    internals.onProjectileLaunched({ ...launch, travelDurationMs: Number.NaN });

    expect(internals.activeProjectiles).toHaveLength(0);
  });

  it("rejects non-finite positions instead of poisoning the render loop", () => {
    const { internals } = createRenderer();

    internals.onProjectileLaunched({
      ...launch,
      sourcePosition: { x: Number.NaN, y: 0, z: 0 },
    });

    expect(internals.activeProjectiles).toHaveLength(0);
  });

  it("starts an arrow at the rendered draw hand without a forward pop", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const avatarScene = new THREE.Group();
    avatarScene.position.set(2, 0.25, -1);
    const rightHand = new THREE.Object3D();
    rightHand.position.set(0.3, 1.15, 0.2);
    avatarScene.add(rightHand);
    avatarScene.updateMatrixWorld(true);
    const attacker = {
      _avatar: {
        instance: {
          raw: {
            userData: {
              vrm: {
                humanoid: {
                  getRawBoneNode: (name: string) =>
                    name === "rightHand" ? rightHand : null,
                },
              },
            },
          },
        },
      },
    };
    const { renderer, internals } = createRenderer(attacker);
    const expected = rightHand.getWorldPosition(new THREE.Vector3());

    internals.onProjectileLaunched(launch);

    expect(internals.activeProjectiles).toHaveLength(1);
    expect(internals.activeProjectiles[0].sprite.position.x).toBeCloseTo(
      expected.x,
      6,
    );
    expect(internals.activeProjectiles[0].sprite.position.y).toBeCloseTo(
      expected.y,
      6,
    );
    expect(internals.activeProjectiles[0].sprite.position.z).toBeCloseTo(
      expected.z,
      6,
    );
    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      schemaVersion: 1,
      latestSequence: 1,
      arrowLaunchEventCount: 1,
      arrowSpawnCount: 1,
      arrowCancelledBeforeSpawnCount: 0,
      pendingArrowCount: 0,
      activeArrows: [
        {
          sequence: 1,
          attackerId: "ranger",
          targetId: "mage",
          arrowId: "rune_arrow",
          startPosition: [expected.x, expected.y, expected.z],
        },
      ],
      recentArrowSpawns: [
        {
          sequence: 1,
          attackerId: "ranger",
          targetId: "mage",
          arrowId: "rune_arrow",
          startPosition: [expected.x, expected.y, expected.z],
        },
      ],
    });
  });

  it("records a delayed arrow cancelled before spawn without a ghost visual", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(10);
    const { renderer, internals } = createRenderer();

    internals.onProjectileLaunched({ ...launch, delayMs: 400 });
    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowLaunchEventCount: 1,
      arrowSpawnCount: 0,
      arrowCancelledBeforeSpawnCount: 0,
      pendingArrowCount: 1,
    });

    internals.onProjectileHit({
      ...impact,
      projectileId: undefined,
      networkEventId: undefined,
    });
    vi.advanceTimersByTime(1_000);

    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowLaunchEventCount: 1,
      arrowSpawnCount: 0,
      arrowCancelledBeforeSpawnCount: 1,
      pendingArrowCount: 0,
      activeArrows: [],
      recentArrowSpawns: [],
    });
  });

  it("releases the exact buffered arrow from the rendered draw hand", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(10);
    const { renderer, internals } = createRenderer();

    internals.onProjectileLaunched({
      ...launch,
      delayMs: 400,
      networkEventId: "server-a:launch-1",
    });
    expect(
      internals.releaseDelayedArrow("server-a:launch-1", [1.25, 2.5, -0.75]),
    ).toBe(true);

    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowLaunchEventCount: 1,
      arrowSpawnCount: 1,
      arrowCancelledBeforeSpawnCount: 0,
      pendingArrowCount: 0,
      activeArrows: [
        {
          networkEventId: "server-a:launch-1",
          startPosition: [1.25, 2.5, -0.75],
        },
      ],
    });
    expect(internals.releaseDelayedArrow("server-a:launch-1", [9, 9, 9])).toBe(
      false,
    );
    vi.advanceTimersByTime(1_000);
    expect(
      renderer.getStreamingProjectileVisualDiagnostics().arrowSpawnCount,
    ).toBe(1);
  });

  it("materializes only the exact older arrow when it impacts during a newer draw", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(10);
    const { renderer, internals } = createRenderer();

    internals.onProjectileLaunched({
      ...launch,
      projectileId: "projectile-1",
      delayMs: 400,
      networkEventId: "server-a:launch-1",
    });
    internals.onProjectileLaunched({
      ...launch,
      projectileId: "projectile-2",
      delayMs: 400,
      networkEventId: "server-a:launch-2",
    });

    internals.onProjectileHit({
      ...impact,
      projectileId: "projectile-1",
      networkEventId: "server-a:impact-1",
    });

    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowLaunchEventCount: 2,
      arrowSpawnCount: 1,
      arrowCancelledBeforeSpawnCount: 0,
      pendingArrowCount: 1,
      activeArrows: [
        {
          projectileId: "projectile-1",
          networkEventId: "server-a:launch-1",
        },
      ],
    });
    expect(
      internals.releaseDelayedArrow("server-a:launch-2", [1.5, 2.25, -0.5]),
    ).toBe(true);
    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowSpawnCount: 2,
      pendingArrowCount: 0,
      activeArrows: [
        {
          projectileId: "projectile-1",
          networkEventId: "server-a:launch-1",
        },
        {
          projectileId: "projectile-2",
          networkEventId: "server-a:launch-2",
          startPosition: [1.5, 2.25, -0.5],
        },
      ],
    });
  });

  it("forces the exact fitted-bow release before an early authoritative impact", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(10);
    let internals: ProjectileRendererInternals;
    let renderer: ProjectileRenderer;
    const releaseCommittedArrowNow = vi.fn(
      (_playerId: string, networkEventId: string) =>
        internals.releaseDelayedArrow(networkEventId, [1.25, 2.5, -0.75]),
    );
    ({ renderer, internals } = createRenderer(null, {
      releaseCommittedArrowNow,
    }));

    internals.onProjectileLaunched({
      ...launch,
      projectileId: "projectile-early-impact",
      delayMs: 400,
      networkEventId: "server-a:launch-early-impact",
    });
    internals.onProjectileHit({
      ...impact,
      projectileId: "projectile-early-impact",
      networkEventId: "server-a:impact-early",
    });

    expect(releaseCommittedArrowNow).toHaveBeenCalledWith(
      "ranger",
      "server-a:launch-early-impact",
    );
    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowLaunchEventCount: 1,
      arrowSpawnCount: 1,
      arrowCancelledBeforeSpawnCount: 0,
      pendingArrowCount: 0,
      recentArrowSpawns: [
        {
          projectileId: "projectile-early-impact",
          networkEventId: "server-a:launch-early-impact",
          startPosition: [1.25, 2.5, -0.75],
        },
      ],
    });
    vi.advanceTimersByTime(1_000);
    expect(
      renderer.getStreamingProjectileVisualDiagnostics().arrowSpawnCount,
    ).toBe(1);
  });

  it("gives the bow controller a release-frame grace before timer fallback", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(10);
    const { renderer, internals } = createRenderer();

    internals.onProjectileLaunched({
      ...launch,
      projectileId: "projectile-grace",
      delayMs: 400,
      networkEventId: "server-a:launch-grace",
    });
    vi.advanceTimersByTime(400);

    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowSpawnCount: 0,
      pendingArrowCount: 1,
    });
    expect(
      internals.releaseDelayedArrow("server-a:launch-grace", [2, 3, 4]),
    ).toBe(true);
    vi.advanceTimersByTime(100);
    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowSpawnCount: 1,
      pendingArrowCount: 0,
      recentArrowSpawns: [
        {
          projectileId: "projectile-grace",
          startPosition: [2, 3, 4],
        },
      ],
    });
  });

  it("materializes an overdue buffered release before its impact", () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, "now").mockReturnValue(10);
    const { renderer, internals } = createRenderer();

    internals.onProjectileLaunched({
      ...launch,
      delayMs: 400,
      networkEventId: "server-a:launch-overdue",
    });
    now.mockReturnValue(500);
    internals.onProjectileHit({
      ...impact,
      projectileId: undefined,
      networkEventId: undefined,
    });

    expect(renderer.getStreamingProjectileVisualDiagnostics()).toMatchObject({
      arrowLaunchEventCount: 1,
      arrowSpawnCount: 1,
      arrowCancelledBeforeSpawnCount: 0,
      pendingArrowCount: 0,
      recentArrowSpawns: [
        {
          networkEventId: "server-a:launch-overdue",
        },
      ],
    });
  });

  it("reuses one geometry pair across repeated arrows with the same dimensions", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const { renderer, internals } = createRenderer();

    internals.onProjectileLaunched(launch);
    const firstMeshes: THREE.Mesh[] = [];
    internals.activeProjectiles[0].sprite.traverse((child) => {
      if (child instanceof THREE.Mesh) firstMeshes.push(child);
    });

    now.mockReturnValue(600);
    internals.onProjectileHit(impact);
    renderer.update(0.6);
    internals.onProjectileLaunched(launch);
    const secondMeshes: THREE.Mesh[] = [];
    internals.activeProjectiles.at(-1)!.sprite.traverse((child) => {
      if (child instanceof THREE.Mesh) secondMeshes.push(child);
    });

    expect(firstMeshes).toHaveLength(4);
    expect(secondMeshes).toHaveLength(4);
    secondMeshes.forEach((mesh, index) =>
      expect(mesh.geometry).toBe(firstMeshes[index].geometry),
    );
    expect(internals.arrowGeometryCache.size).toBe(1);
  });

  it("disposes the cached arrow geometry pair when the renderer is destroyed", () => {
    const { renderer, internals } = createRenderer();
    internals.onProjectileLaunched(launch);
    const geometries = [...internals.arrowGeometryCache.values()][0];
    const disposeShaft = vi.spyOn(geometries.shaft, "dispose");
    const disposeHead = vi.spyOn(geometries.head, "dispose");
    const disposeFletching = vi.spyOn(geometries.fletching, "dispose");

    renderer.destroy();

    expect(disposeShaft).toHaveBeenCalledOnce();
    expect(disposeHead).toHaveBeenCalledOnce();
    expect(disposeFletching).toHaveBeenCalledOnce();
    expect(internals.arrowGeometryCache.size).toBe(0);
  });
});
