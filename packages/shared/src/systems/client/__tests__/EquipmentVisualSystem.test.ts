import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import {
  EquipmentVisualSystem,
  isStreamingDuelCertifiedEquipmentSlot,
  STREAMING_DUEL_INTENTIONALLY_INVISIBLE_EQUIPMENT_SLOTS,
  STREAMING_DUEL_VISIBLE_EQUIPMENT_SLOTS,
} from "../EquipmentVisualSystem";
import {
  createDynamicBowStringController,
  createStableHeldEquipmentPoseController,
  createTwoHandEquipmentGripController,
  extractFishingWorldVisualPlacement,
  resolveEquipmentVisualUrls,
  shouldRenderHeldEquipmentVisual,
  validateStreamingEquipmentVisualModel,
  type DynamicBowStringTransition,
} from "../EquipmentVisualHelpers";
import { EventType } from "../../../types/events";
import { isStreamingLikeViewport } from "../../../runtime/clientViewportMode";

const TEST_RIG_FINGERPRINT = "a".repeat(64);

// Mock dependencies
vi.mock("three/examples/jsm/libs/meshopt_decoder.module.js", () => ({
  MeshoptDecoder: {},
}));

vi.mock("../../../runtime/clientViewportMode", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../runtime/clientViewportMode")
  >()),
  isStreamingLikeViewport: vi.fn(() => false),
}));

vi.mock("../../../libs/gltfloader/GLTFLoader", () => {
  const itemIdFromUrl = (url: string) => {
    if (url.includes("shortsword-bronze")) return "bronze_shortsword";
    if (url.includes("longsword-bronze")) return "bronze_longsword";
    if (url.includes("staff-of-air-steve-fitted")) return "staff_of_air";
    return (
      url
        .split("/")
        .pop()
        ?.replace(/\.glb$/u, "") ?? "unknown_item"
    );
  };
  const createMockScene = (itemId: string) => {
    const attachment = {
      version: 2,
      vrmBoneName: "rightHand",
      relativeMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      duelFit: {
        schemaVersion: 1,
        itemId,
        slot: "weapon",
        compatibleAvatarIds: ["bandit"],
      },
    };
    return {
      userData: { hyperia: attachment },
      clone: () => ({
        userData: { hyperia: attachment },
        children: [],
        traverse: (fn: (child: unknown) => void) => void fn,
        add: () => {},
        remove: () => {},
        scale: { set: vi.fn(), multiplyScalar: vi.fn() },
        position: { copy: vi.fn() },
        quaternion: { copy: vi.fn() },
        visible: true,
      }),
      children: [],
      traverse: (fn: (child: unknown) => void) => void fn,
    };
  };

  class MockGLTFLoader {
    setMeshoptDecoder = vi.fn();
    loadAsync = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve({ scene: createMockScene(itemIdFromUrl(url)) }),
      );
    parseAsync = vi
      .fn()
      .mockImplementation((_buffer: ArrayBuffer, url: string) =>
        Promise.resolve({ scene: createMockScene(itemIdFromUrl(url)) }),
      );
  }

  return {
    GLTFLoader: MockGLTFLoader,
  };
});

import * as itemsModule from "../../../data/items";

const originalGetItem = itemsModule.getItem;
vi.spyOn(itemsModule, "getItem").mockImplementation((id: string) => {
  const realItem = originalGetItem(id);
  if (realItem) {
    // Model-system tests parse an eight-byte synthetic File, not the authored
    // production GLB. Production content identities are covered by the URL,
    // mismatch, manifest-audit, and asset-validation cases instead.
    return {
      ...realItem,
      equippedModelSha256: undefined,
      equippedModelSha256ByAvatar: undefined,
      gatheringModelSha256ByAvatar: undefined,
    };
  }
  // Partial Item stub — only the fields needed for equipment visual tests.
  // Full Item type requires many fields irrelevant to model loading.
  return {
    id,
    modelPath: `asset://models/${id}.glb`,
    equippedModelPath: `asset://models/${id}.glb`,
  } as unknown as ReturnType<typeof originalGetItem>;
});

describe("streaming equipment certification scope", () => {
  it("certifies temporary gathering tools without adding them to the frozen loadout contract", () => {
    expect(isStreamingDuelCertifiedEquipmentSlot("weapon")).toBe(true);
    expect(isStreamingDuelCertifiedEquipmentSlot("gatheringTool")).toBe(true);
    expect(isStreamingDuelCertifiedEquipmentSlot("unknown")).toBe(false);
    expect(STREAMING_DUEL_VISIBLE_EQUIPMENT_SLOTS).not.toContain(
      "gatheringtool",
    );
  });
});

describe("EquipmentVisualSystem", () => {
  let system: EquipmentVisualSystem;
  let mockWorld: any;
  let mockPlayer: any;
  let mockVRM: any;

  beforeEach(async () => {
    vi.mocked(isStreamingLikeViewport).mockReturnValue(false);
    // Setup mock world
    // Create a mock File that returns an ArrayBuffer
    const mockFile = new File([new ArrayBuffer(8)], "mock.glb", {
      type: "model/gltf-binary",
    });

    mockWorld = {
      isServer: false,
      assetsUrl: "http://localhost:8080/assets",
      $eventBus: {
        subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
        emitEvent: vi.fn(),
      },
      events: {
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
      },
      entities: new Map(),
      network: { connected: true },
      getSystem: vi.fn(),
      loader: {
        loadFile: vi.fn().mockResolvedValue(mockFile),
      },
      stage: { scene: new THREE.Scene() },
    };

    // Setup mock VRM
    const mockBone = new THREE.Object3D();
    mockBone.name = "rightHand";
    // Mock add to allow adding non-Object3D mocks
    mockBone.add = vi.fn();

    mockVRM = {
      humanoid: {
        getNormalizedBoneNode: vi.fn().mockReturnValue(mockBone),
        getRawBoneNode: vi.fn().mockReturnValue(mockBone),
      },
      scene: new THREE.Group(),
    };

    // Setup mock player
    mockPlayer = {
      id: "player1",
      avatarUrl: "asset://avatars/duel-candidates/duel-bandit.vrm",
      data: {
        avatar: "asset://avatars/duel-candidates/duel-bandit.vrm",
      },
      _avatar: {
        instance: {
          raw: {
            userData: {
              vrm: mockVRM,
            },
            scene: new THREE.Group(),
          },
        },
      },
      node: new THREE.Group(),
    };

    // Add bone to player node hierarchy (simulating raw avatar)
    mockPlayer._avatar.instance.raw.scene.add(mockBone);

    mockWorld.entities.set("player1", mockPlayer);

    // Initialize system
    system = new EquipmentVisualSystem(mockWorld);
    // Manually call init since we're testing logic that might run in constructor or init
    await system.init();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should initialize and subscribe to events", async () => {
    expect(mockWorld.$eventBus.subscribe).toHaveBeenCalledWith(
      EventType.PLAYER_EQUIPMENT_CHANGED,
      expect.any(Function),
    );
    expect(mockWorld.$eventBus.subscribe).toHaveBeenCalledWith(
      EventType.PLAYER_CLEANUP,
      expect.any(Function),
    );
    expect(mockWorld.$eventBus.subscribe).toHaveBeenCalledWith(
      EventType.AVATAR_LOAD_COMPLETE,
      expect.any(Function),
    );
  });

  it("waits for the spectator snapshot before resolving streaming asset URLs", async () => {
    vi.mocked(isStreamingLikeViewport).mockReturnValue(true);
    mockWorld.network.connected = false;
    mockWorld.assetsUrl = "/assets/";

    system.setStreamingDuelEquipmentVisualContract({
      cycleId: "cycle-assets-startup-race",
      requirements: [
        { playerId: "player1", itemId: "bronze_sword", slot: "weapon" },
      ],
      currentEquipment: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockWorld.loader.loadFile).not.toHaveBeenCalled();

    mockWorld.assetsUrl = "http://localhost:5555/game-assets";
    mockWorld.network.connected = true;

    await vi.waitFor(() => {
      expect(mockWorld.loader.loadFile).toHaveBeenCalledWith(
        "http://localhost:5555/game-assets/models/bronze_sword.glb",
      );
      expect(system.getStreamingDuelEquipmentVisualReadiness().ready).toBe(
        true,
      );
    });
  });

  it("keeps a failed prewarm unresolved and retries it in a replacement cycle", async () => {
    mockWorld.loader.loadFile.mockRejectedValueOnce(
      new Error("injected equipment transport failure"),
    );
    const requirement = {
      playerId: "player1",
      itemId: "network_fault_sword",
      slot: "weapon" as const,
    };

    system.setStreamingDuelEquipmentVisualContract({
      cycleId: "cycle-failed-prewarm",
      requirements: [requirement],
      currentEquipment: [],
    });

    await vi.waitFor(() => {
      expect(system.getStreamingDuelEquipmentVisualReadiness()).toMatchObject({
        ready: false,
        cycleId: "cycle-failed-prewarm",
        requiredCount: 1,
        readyCount: 0,
        unresolved: [{ ...requirement, status: "load_failed" }],
      });
    });

    system.setStreamingDuelEquipmentVisualContract({
      cycleId: "cycle-retry-prewarm",
      requirements: [requirement],
      currentEquipment: [],
    });

    await vi.waitFor(() => {
      expect(system.getStreamingDuelEquipmentVisualReadiness()).toMatchObject({
        ready: true,
        cycleId: "cycle-retry-prewarm",
        requiredCount: 1,
        readyCount: 1,
        unresolved: [],
      });
    });
    expect(mockWorld.loader.loadFile).toHaveBeenCalledTimes(2);
  });

  it("routes an authoritative arrow release without pair-wide cleanup", () => {
    const scheduleRelease = vi.fn().mockReturnValue(true);
    const cancelRelease = vi.fn();
    (
      system as unknown as {
        dynamicBowStrings: Map<string, unknown>;
      }
    ).dynamicBowStrings.set("player1", {
      scheduleRelease,
      cancelRelease,
    });
    const subscription = (event: EventType) =>
      mockWorld.$eventBus.subscribe.mock.calls.find(
        ([registered]: [EventType]) => registered === event,
      )?.[1] as ((data: unknown) => void) | undefined;

    subscription(EventType.COMBAT_PROJECTILE_LAUNCHED)?.({
      data: {
        attackerId: "player1",
        targetId: "player2",
        projectileType: "arrow",
        delayMs: 400,
        arrowId: "bronze_arrow",
        networkEventId: "server-a:launch-1",
      },
    });
    expect(scheduleRelease).toHaveBeenCalledWith(
      400,
      "bronze_arrow",
      "server-a:launch-1",
    );

    subscription(EventType.COMBAT_PROJECTILE_LAUNCHED)?.({
      data: {
        attackerId: "player1",
        targetId: "player2",
        projectileType: "spell",
        delayMs: 600,
      },
    });
    expect(scheduleRelease).toHaveBeenCalledOnce();

    expect(subscription(EventType.COMBAT_ENDED)).toBeUndefined();
    expect(cancelRelease).not.toHaveBeenCalled();
  });

  it("preserves an authoritative arrow deadline until the fitted bow attaches", () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const subscription = (event: EventType) =>
      mockWorld.$eventBus.subscribe.mock.calls.find(
        ([registered]: [EventType]) => registered === event,
      )?.[1] as ((data: unknown) => void) | undefined;

    subscription(EventType.COMBAT_PROJECTILE_LAUNCHED)?.({
      data: {
        attackerId: "player1",
        targetId: "player2",
        projectileType: "arrow",
        delayMs: 400,
        arrowId: "bronze_arrow",
        networkEventId: "server-a:launch-2",
      },
    });

    const scheduleRelease = vi.fn().mockReturnValue(true);
    now = 1_125;
    (
      system as unknown as {
        flushPendingBowRelease: (
          playerId: string,
          controller: { scheduleRelease: typeof scheduleRelease },
        ) => void;
      }
    ).flushPendingBowRelease("player1", { scheduleRelease });
    expect(scheduleRelease).toHaveBeenCalledWith(
      275,
      "bronze_arrow",
      "server-a:launch-2",
    );

    subscription(EventType.COMBAT_PROJECTILE_LAUNCHED)?.({
      data: {
        attackerId: "player1",
        targetId: "player2",
        projectileType: "arrow",
        delayMs: 400,
        arrowId: "bronze_arrow",
      },
    });
    now = 1_800;
    (
      system as unknown as {
        flushPendingBowRelease: (
          playerId: string,
          controller: { scheduleRelease: typeof scheduleRelease },
        ) => void;
      }
    ).flushPendingBowRelease("player1", { scheduleRelease });
    expect(scheduleRelease).toHaveBeenCalledOnce();
  });

  it("updates fitted transforms before dependent bow-string geometry", () => {
    const order: string[] = [];
    const internals = system as any;
    internals.stableHeldEquipmentPoses.set("player1", {
      update: () => order.push("stable"),
    });
    internals.twoHandEquipmentGrips.set("player1", {
      update: () => order.push("two-hand"),
    });
    internals.dynamicBowStrings.set("player1", {
      update: () => order.push("bow-string"),
    });

    system.update(0);

    expect(order).toEqual(["stable", "two-hand", "bow-string"]);
  });

  it("does not cancel a bow release for an unchanged complete equipment snapshot", async () => {
    const dispose = vi.fn();
    const existingBow = new THREE.Group();
    const internals = system as any;
    internals.playerEquipment.set("player1", { weapon: existingBow });
    internals.attachedEquipmentItemIds.set(
      "player1",
      new Map([["weapon", "shortbow"]]),
    );
    internals.attachedEquipmentAvatarVrms.set(
      "player1",
      new Map([["weapon", mockVRM]]),
    );
    internals.dynamicBowStrings.set("player1", { dispose });

    await internals.handleEquipmentChange({
      playerId: "player1",
      slot: "weapon",
      itemId: "shortbow",
    });

    expect(dispose).not.toHaveBeenCalled();
    expect(internals.playerEquipment.get("player1")?.weapon).toBe(existingBow);
    expect(mockWorld.loader.loadFile).not.toHaveBeenCalled();
  });

  it("exposes only requested players in bounded bow transition diagnostics", () => {
    const visibleNock = new THREE.Group();
    visibleNock.position.set(1, 2, 3);
    visibleNock.visible = true;
    const internals = system as unknown as {
      dynamicBowStrings: Map<string, unknown>;
      playerWeaponItemIds: Map<string, string>;
      recordBowTransition: (
        playerId: string,
        transition: DynamicBowStringTransition,
      ) => void;
    };
    internals.dynamicBowStrings.set("player1", {
      nockedArrow: visibleNock,
    });
    internals.playerWeaponItemIds.set("player1", "shortbow");
    internals.recordBowTransition("player1", {
      kind: "released",
      performanceTimeMs: 1_400,
      lastVisibleNockWorldPosition: [1, 2, 3],
      drawHandWorldPosition: [1, 2, 3],
      networkEventId: "server-a:launch-3",
    });
    internals.recordBowTransition("different-player", {
      kind: "cancelled",
      performanceTimeMs: 1_500,
      networkEventId: "server-a:launch-4",
    });

    expect(
      system.getStreamingDuelBowPresentationDiagnostics(["player1"]),
    ).toMatchObject({
      schemaVersion: 1,
      latestSequence: 2,
      players: [
        {
          playerId: "player1",
          itemId: "shortbow",
          controllerReady: true,
          nockedArrowVisible: true,
          nockedArrowWorldPosition: [1, 2, 3],
        },
      ],
      recentTransitions: [
        {
          sequence: 1,
          playerId: "player1",
          itemId: "shortbow",
          kind: "released",
          performanceTimeMs: 1_400,
          releaseAtPerformanceTimeMs: null,
          networkEventId: "server-a:launch-3",
          lastVisibleNockWorldPosition: [1, 2, 3],
          drawHandWorldPosition: [1, 2, 3],
        },
      ],
    });
  });

  it("releases the matching buffered projectile from the bow hand", () => {
    const releaseDelayedArrow = vi.fn().mockReturnValue(true);
    mockWorld.getSystem.mockImplementation((name: string) =>
      name === "projectile-renderer" ? { releaseDelayedArrow } : undefined,
    );
    const internals = system as unknown as {
      recordBowTransition: (
        playerId: string,
        transition: DynamicBowStringTransition,
      ) => void;
    };

    internals.recordBowTransition("player1", {
      kind: "released",
      performanceTimeMs: 1_400,
      lastVisibleNockWorldPosition: [1, 2, 3],
      drawHandWorldPosition: [1, 2, 3],
      networkEventId: "server-a:launch-synchronized",
    });

    expect(mockWorld.getSystem).toHaveBeenCalledWith("projectile-renderer");
    expect(releaseDelayedArrow).toHaveBeenCalledWith(
      "server-a:launch-synchronized",
      [1, 2, 3],
    );
  });

  it("forces only the exact committed bow release and retires its cold-load fallback", () => {
    const releaseNow = vi.fn().mockReturnValue(true);
    const internals = system as unknown as {
      dynamicBowStrings: Map<string, { releaseNow: typeof releaseNow }>;
      pendingBowReleases: Map<
        string,
        {
          receivedAtPerformanceMs: number;
          delayMs: number;
          networkEventId: string;
        }
      >;
    };
    internals.dynamicBowStrings.set("player1", { releaseNow });

    expect(
      system.releaseCommittedArrowNow("player1", "server-a:launch-exact"),
    ).toBe(true);
    expect(releaseNow).toHaveBeenCalledWith("server-a:launch-exact");

    releaseNow.mockReturnValue(false);
    internals.pendingBowReleases.set("cold-player", {
      receivedAtPerformanceMs: 1_000,
      delayMs: 400,
      networkEventId: "server-a:launch-cold",
    });
    expect(
      system.releaseCommittedArrowNow(
        "cold-player",
        "server-a:launch-different",
      ),
    ).toBe(false);
    expect(internals.pendingBowReleases.has("cold-player")).toBe(true);
    expect(
      system.releaseCommittedArrowNow("cold-player", "server-a:launch-cold"),
    ).toBe(false);
    expect(internals.pendingBowReleases.has("cold-player")).toBe(false);
  });

  it("cancels only the exact committed bow draw", () => {
    const cancelRelease = vi.fn().mockReturnValue(true);
    const internals = system as unknown as {
      dynamicBowStrings: Map<string, { cancelRelease: typeof cancelRelease }>;
      pendingBowReleases: Map<
        string,
        {
          receivedAtPerformanceMs: number;
          delayMs: number;
          networkEventId: string;
        }
      >;
    };
    internals.dynamicBowStrings.set("player1", { cancelRelease });

    expect(
      system.cancelCommittedArrow("player1", "server-a:launch-exact"),
    ).toBe(true);
    expect(cancelRelease).toHaveBeenCalledWith("server-a:launch-exact");

    cancelRelease.mockReturnValue(false);
    internals.pendingBowReleases.set("cold-player", {
      receivedAtPerformanceMs: 1_000,
      delayMs: 400,
      networkEventId: "server-a:launch-cold",
    });
    expect(
      system.cancelCommittedArrow("cold-player", "server-a:launch-different"),
    ).toBe(false);
    expect(internals.pendingBowReleases.has("cold-player")).toBe(true);
    expect(
      system.cancelCommittedArrow("cold-player", "server-a:launch-cold"),
    ).toBe(true);
    expect(internals.pendingBowReleases.has("cold-player")).toBe(false);
  });

  it("declares the exact visible and intentionally non-mesh competitive slots", () => {
    expect(STREAMING_DUEL_VISIBLE_EQUIPMENT_SLOTS).toEqual([
      "weapon",
      "shield",
      "helmet",
      "body",
      "legs",
      "boots",
      "gloves",
      "cape",
    ]);
    expect(STREAMING_DUEL_INTENTIONALLY_INVISIBLE_EQUIPMENT_SLOTS).toEqual({
      arrows: "authoritative_projectile_visual",
      amulet: "public_loadout_disclosure_only",
      ring: "public_loadout_disclosure_only",
    });
  });

  it("fails closed before configuration and accepts an empty maintenance contract", () => {
    expect(system.getStreamingDuelEquipmentVisualReadiness()).toMatchObject({
      configured: false,
      ready: false,
    });
    system.setStreamingDuelEquipmentVisualContract({
      cycleId: "",
      requirements: [],
      currentEquipment: [],
    });
    expect(system.getStreamingDuelEquipmentVisualReadiness()).toMatchObject({
      configured: true,
      ready: true,
      cycleId: null,
      requiredCount: 0,
      requiredPlayerCount: 0,
      readyCount: 0,
      expectedPlayerCount: 0,
      activeVisualCount: 0,
      activeVisibleCount: 0,
      activePlayerCount: 0,
      activeVisiblePlayerCount: 0,
    });
  });

  it("pre-warms the cycle-derived set and rejects armor with weapon-only fit metadata", async () => {
    system.setStreamingDuelEquipmentVisualContract({
      cycleId: "cycle-armor",
      requirements: [
        {
          playerId: "player1",
          itemId: "bronze_shortsword",
          slot: "weapon",
        },
        {
          playerId: "player1",
          itemId: "test_platebody_visual",
          slot: "body",
        },
      ],
      currentEquipment: [],
    });

    await vi.waitFor(() => {
      expect(system.getStreamingDuelEquipmentVisualReadiness()).toMatchObject({
        configured: true,
        ready: false,
        cycleId: "cycle-armor",
        requiredCount: 2,
        requiredPlayerCount: 1,
        readyCount: 1,
        expectedPlayerCount: 0,
        unresolved: [
          {
            itemId: "test_platebody_visual",
            playerId: "player1",
            slot: "body",
            status: "invalid_model",
          },
        ],
      });
    });
  });

  it("bootstraps a missing cold-spectator equipment event from the public contract", async () => {
    system.setStreamingDuelEquipmentVisualContract({
      cycleId: "cycle-attachment",
      requirements: [
        { playerId: "player1", itemId: "bronze_sword", slot: "weapon" },
      ],
      currentEquipment: [
        { playerId: "player1", itemId: "bronze_sword", slot: "weapon" },
      ],
    });

    await vi.waitFor(() => {
      expect(system.getStreamingDuelEquipmentVisualReadiness()).toMatchObject({
        ready: true,
        activeVisualCount: 1,
        activeVisibleCount: 1,
        activePlayerCount: 1,
        activeVisiblePlayerCount: 1,
        attachmentMismatches: [],
      });
    });
  });

  it("does not report an attached but hidden active weapon as visible", async () => {
    system.setStreamingDuelEquipmentVisualContract({
      cycleId: "cycle-hidden-active-weapon",
      requirements: [
        { playerId: "player1", itemId: "bronze_sword", slot: "weapon" },
      ],
      currentEquipment: [
        { playerId: "player1", itemId: "bronze_sword", slot: "weapon" },
      ],
    });
    const internals = system as any;
    await internals.handleEquipmentChange({
      playerId: "player1",
      slot: "weapon",
      itemId: "bronze_sword",
    });
    internals.playerEquipment.get("player1").weapon.visible = false;

    expect(system.getStreamingDuelEquipmentVisualReadiness()).toMatchObject({
      ready: true,
      activeVisualCount: 1,
      activeVisibleCount: 0,
      activePlayerCount: 1,
      activeVisiblePlayerCount: 0,
      attachmentMismatches: [],
    });
  });

  it("fails closed across avatar replacement and reattaches desired equipment", async () => {
    system.setStreamingDuelEquipmentVisualContract({
      cycleId: "cycle-avatar-replacement",
      requirements: [
        { playerId: "player1", itemId: "bronze_sword", slot: "weapon" },
      ],
      currentEquipment: [
        { playerId: "player1", itemId: "bronze_sword", slot: "weapon" },
      ],
    });
    const internals = system as any;
    await internals.handleEquipmentChange({
      playerId: "player1",
      slot: "weapon",
      itemId: "bronze_sword",
    });
    await vi.waitFor(() => {
      expect(system.getStreamingDuelEquipmentVisualReadiness().ready).toBe(
        true,
      );
    });

    const replacementBone = new THREE.Object3D();
    replacementBone.name = "rightHand";
    replacementBone.add = vi.fn();
    const replacementVrm = {
      humanoid: {
        getNormalizedBoneNode: vi.fn().mockReturnValue(replacementBone),
        getRawBoneNode: vi.fn().mockReturnValue(replacementBone),
      },
      scene: new THREE.Group(),
    };
    const replacementScene = new THREE.Group();
    replacementScene.add(replacementBone);
    mockPlayer._avatar.instance.raw = {
      userData: { vrm: replacementVrm },
      scene: replacementScene,
    };

    expect(system.getStreamingDuelEquipmentVisualReadiness()).toMatchObject({
      ready: false,
      attachmentMismatches: [
        {
          playerId: "player1",
          itemId: "bronze_sword",
          slot: "weapon",
          desiredItemId: "bronze_sword",
          attachedItemId: "bronze_sword",
        },
      ],
    });

    const avatarReady = mockWorld.$eventBus.subscribe.mock.calls.find(
      ([registered]: [EventType]) =>
        registered === EventType.AVATAR_LOAD_COMPLETE,
    )?.[1] as ((event: unknown) => void) | undefined;
    avatarReady?.({
      data: { playerId: "player1", success: true },
    });

    await vi.waitFor(() => {
      expect(system.getStreamingDuelEquipmentVisualReadiness()).toMatchObject({
        ready: true,
        attachmentMismatches: [],
      });
    });
    expect(
      internals.attachedEquipmentAvatarVrms.get("player1")?.get("weapon"),
    ).toBe(replacementVrm);
  });

  it("accepts an attached frozen role switch while the public projection catches up", async () => {
    system.setStreamingDuelEquipmentVisualContract({
      cycleId: "cycle-role-switch",
      requirements: [
        { playerId: "player1", itemId: "bronze_sword", slot: "weapon" },
        { playerId: "player1", itemId: "staff_of_air", slot: "weapon" },
      ],
      currentEquipment: [
        { playerId: "player1", itemId: "bronze_sword", slot: "weapon" },
      ],
    });

    const handler = (
      system as unknown as {
        handleEquipmentChange: (data: {
          playerId: string;
          slot: string;
          itemId: string | null;
        }) => Promise<void>;
      }
    ).handleEquipmentChange.bind(system);
    await handler({
      playerId: "player1",
      slot: "weapon",
      itemId: "staff_of_air",
    });

    // The public projection may lag the replicated equipment stream by one
    // ordered update. Reapplying it must not revert the known desired item.
    system.setStreamingDuelEquipmentVisualContract({
      cycleId: "cycle-role-switch",
      requirements: [
        { playerId: "player1", itemId: "bronze_sword", slot: "weapon" },
        { playerId: "player1", itemId: "staff_of_air", slot: "weapon" },
      ],
      currentEquipment: [
        { playerId: "player1", itemId: "bronze_sword", slot: "weapon" },
      ],
    });

    await vi.waitFor(() => {
      expect(system.getStreamingDuelEquipmentVisualReadiness()).toMatchObject({
        ready: true,
        requiredCount: 2,
        readyCount: 2,
        attachmentMismatches: [],
      });
    });
  });

  it("rejects an attached item outside the frozen visual contract", async () => {
    system.setStreamingDuelEquipmentVisualContract({
      cycleId: "cycle-unapproved-switch",
      requirements: [
        { playerId: "player1", itemId: "bronze_sword", slot: "weapon" },
      ],
      currentEquipment: [
        { playerId: "player1", itemId: "bronze_sword", slot: "weapon" },
      ],
    });

    const handler = (
      system as unknown as {
        handleEquipmentChange: (data: {
          playerId: string;
          slot: string;
          itemId: string | null;
        }) => Promise<void>;
      }
    ).handleEquipmentChange.bind(system);
    await handler({
      playerId: "player1",
      slot: "weapon",
      itemId: "staff_of_air",
    });

    await vi.waitFor(() => {
      expect(system.getStreamingDuelEquipmentVisualReadiness()).toMatchObject({
        ready: false,
        attachmentMismatches: [
          {
            playerId: "player1",
            itemId: "bronze_sword",
            slot: "weapon",
            desiredItemId: "staff_of_air",
            attachedItemId: "staff_of_air",
          },
        ],
      });
    });
  });

  it("rejects a prewarmed item that was not fitted for the contestant avatar", async () => {
    mockPlayer.avatarUrl =
      "asset://avatars/duel-candidates/duel-dark-wizard.vrm";
    mockPlayer.data.avatar = mockPlayer.avatarUrl;
    system.setStreamingDuelEquipmentVisualContract({
      cycleId: "cycle-incompatible-avatar",
      requirements: [
        { playerId: "player1", itemId: "bronze_sword", slot: "weapon" },
      ],
      currentEquipment: [],
    });

    await vi.waitFor(() => {
      expect(system.getStreamingDuelEquipmentVisualReadiness()).toMatchObject({
        ready: false,
        readyCount: 0,
        unresolved: [
          {
            playerId: "player1",
            itemId: "bronze_sword",
            slot: "weapon",
            status: "incompatible_avatar",
          },
        ],
      });
    });
  });

  it("does not infer a nonexistent equipped model when ammunition opts out", () => {
    expect(
      resolveEquipmentVisualUrls({
        assetsUrl: "http://localhost:5555/game-assets",
        itemId: "rune_arrow",
        slot: "arrows",
        itemData: { modelPath: null, equippedModelPath: null },
      }),
    ).toBeNull();
  });

  it("selects an exact avatar-specific fit before the default equipped model", () => {
    const itemData = {
      equippedModelPath: "asset://models/default-fitted.glb",
      equippedModelPathsByAvatar: {
        "kaykit-knight": "asset://models/kaykit-fitted.glb",
      },
      modelPath: "asset://models/dropped.glb",
    };

    expect(
      resolveEquipmentVisualUrls({
        assetsUrl: "http://localhost:5555/game-assets",
        itemId: "test_sword",
        slot: "weapon",
        avatarId: "kaykit-knight",
        itemData,
      })?.primaryUrl,
    ).toBe("http://localhost:5555/game-assets/models/kaykit-fitted.glb");
    expect(
      resolveEquipmentVisualUrls({
        assetsUrl: "http://localhost:5555/game-assets",
        itemId: "test_sword",
        slot: "weapon",
        avatarId: "steve",
        itemData,
      })?.primaryUrl,
    ).toBe("http://localhost:5555/game-assets/models/default-fitted.glb");
  });

  it("content-addresses certified equipped models for persistent-cache safety", () => {
    const defaultSha256 = "a".repeat(64);
    const kaykitSha256 = "b".repeat(64);
    const itemData = {
      equippedModelPath: "asset://models/default-fitted.glb",
      equippedModelSha256: defaultSha256,
      equippedModelPathsByAvatar: {
        "kaykit-knight": "asset://models/kaykit-fitted.glb",
      },
      equippedModelSha256ByAvatar: {
        "kaykit-knight": kaykitSha256,
      },
    };

    expect(
      resolveEquipmentVisualUrls({
        assetsUrl: "http://localhost:5555/game-assets",
        itemId: "test_sword",
        slot: "weapon",
        avatarId: "steve",
        itemData,
      }),
    ).toEqual({
      primaryUrl: `http://localhost:5555/game-assets/models/default-fitted.glb?sha256=${defaultSha256}`,
      fallbackUrl: null,
      contentSha256: defaultSha256,
    });
    expect(
      resolveEquipmentVisualUrls({
        assetsUrl: "http://localhost:5555/game-assets",
        itemId: "test_sword",
        slot: "weapon",
        avatarId: "kaykit-knight",
        itemData,
      }),
    ).toEqual({
      primaryUrl: `http://localhost:5555/game-assets/models/kaykit-fitted.glb?sha256=${kaykitSha256}`,
      fallbackUrl: null,
      contentSha256: kaykitSha256,
    });
  });

  it("keeps gathering-only fits isolated from the same item's weapon presentation", () => {
    const itemData = {
      equippedModelPath: "asset://models/weapons/bronze-hatchet.glb",
      gatheringModelPathsByAvatar: {
        steve:
          "asset://models/tools/preparation/bronze-hatchet-steve-fitted.glb",
      },
      modelPath: "asset://models/dropped/bronze-hatchet.glb",
    };

    expect(
      resolveEquipmentVisualUrls({
        assetsUrl: "http://localhost:5555/game-assets",
        itemId: "bronze_hatchet",
        slot: "gatheringTool",
        avatarId: "steve",
        itemData,
      })?.primaryUrl,
    ).toBe(
      "http://localhost:5555/game-assets/models/tools/preparation/bronze-hatchet-steve-fitted.glb",
    );
    expect(
      resolveEquipmentVisualUrls({
        assetsUrl: "http://localhost:5555/game-assets",
        itemId: "bronze_hatchet",
        slot: "weapon",
        avatarId: "steve",
        itemData,
      })?.primaryUrl,
    ).toBe(
      "http://localhost:5555/game-assets/models/weapons/bronze-hatchet.glb",
    );
    expect(
      resolveEquipmentVisualUrls({
        assetsUrl: "http://localhost:5555/game-assets",
        itemId: "bronze_hatchet",
        slot: "gatheringTool",
        avatarId: "kaykit-knight",
        requireAvatarSpecificFit: true,
        itemData,
      }),
    ).toBeNull();
    expect(
      resolveEquipmentVisualUrls({
        assetsUrl: "http://localhost:5555/game-assets",
        itemId: "bronze_hatchet",
        slot: "gatheringTool",
        avatarId: "kaykit-knight",
        itemData,
      })?.primaryUrl,
    ).toBe(
      "http://localhost:5555/game-assets/models/weapons/bronze-hatchet.glb",
    );
  });

  it("fails closed when the certified avatar-specific fit is rolled back", () => {
    const activeItem = {
      equippedModelPath: null,
      equippedModelPathsByAvatar: {
        steve: "asset://models/tools/harpoon/harpoon-steve-fitted.glb",
      },
      modelPath: null,
    };
    expect(
      resolveEquipmentVisualUrls({
        assetsUrl: "http://localhost:5555/game-assets",
        itemId: "harpoon",
        slot: "gatheringTool",
        avatarId: "steve",
        itemData: activeItem,
      })?.primaryUrl,
    ).toBe(
      "http://localhost:5555/game-assets/models/tools/harpoon/harpoon-steve-fitted.glb",
    );
    expect(
      resolveEquipmentVisualUrls({
        assetsUrl: "http://localhost:5555/game-assets",
        itemId: "harpoon",
        slot: "gatheringTool",
        avatarId: "kaykit-knight",
        itemData: activeItem,
      }),
    ).toBeNull();
    expect(
      resolveEquipmentVisualUrls({
        assetsUrl: "http://localhost:5555/game-assets",
        itemId: "harpoon",
        slot: "gatheringTool",
        avatarId: "steve",
        itemData: {
          equippedModelPath: null,
          equippedModelPathsByAvatar: {},
          modelPath: null,
        },
      }),
    ).toBeNull();
  });

  it("rejects raw rigid armor and accepts only slot-compatible fitted assets", () => {
    expect(
      validateStreamingEquipmentVisualModel(new THREE.Group(), "weapon"),
    ).toEqual({ valid: false, reason: "missing_fit_metadata" });

    const bodyFit = {
      schemaVersion: 1,
      itemId: "bronze_platebody",
      slot: "body",
      compatibleAvatarIds: ["bandit"],
      rigFingerprint: TEST_RIG_FINGERPRINT,
    };
    const rawBody = new THREE.Group();
    rawBody.userData.hyperia = { duelFit: bodyFit };
    rawBody.add(
      new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()),
    );
    expect(validateStreamingEquipmentVisualModel(rawBody, "body")).toEqual({
      valid: false,
      reason: "missing_skinned_mesh",
    });

    const skinnedBody = new THREE.Group();
    skinnedBody.userData.hyperia = { duelFit: bodyFit };
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0], 3),
    );
    geometry.setAttribute(
      "skinIndex",
      new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4),
    );
    geometry.setAttribute(
      "skinWeight",
      new THREE.Float32BufferAttribute([1, 0, 0, 0], 4),
    );
    const rootBone = new THREE.Bone();
    rootBone.name = "hips";
    const skeleton = new THREE.Skeleton([rootBone]);
    const fittedBody = new THREE.SkinnedMesh(
      geometry,
      new THREE.MeshBasicMaterial(),
    );
    fittedBody.bind(skeleton);
    skinnedBody.add(fittedBody);
    expect(
      validateStreamingEquipmentVisualModel(skinnedBody, "body", {
        itemId: "bronze_platebody",
        avatarId: "bandit",
      }),
    ).toEqual({ valid: true, reason: null });

    const wrongHandShield = new THREE.Group();
    wrongHandShield.userData.hyperia = {
      version: 2,
      vrmBoneName: "rightHand",
      relativeMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      duelFit: {
        schemaVersion: 1,
        itemId: "bronze_kiteshield",
        slot: "shield",
        compatibleAvatarIds: ["bandit"],
      },
    };
    expect(
      validateStreamingEquipmentVisualModel(wrongHandShield, "shield"),
    ).toEqual({ valid: false, reason: "invalid_attachment_bone" });

    const fittedGatheringTool = new THREE.Group();
    fittedGatheringTool.userData.hyperia = {
      version: 2,
      vrmBoneName: "rightHand",
      relativeMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      duelFit: {
        schemaVersion: 1,
        itemId: "bronze_pickaxe",
        slot: "gatheringtool",
        compatibleAvatarIds: ["bandit"],
      },
    };
    expect(
      validateStreamingEquipmentVisualModel(
        fittedGatheringTool,
        "gatheringTool",
        { itemId: "bronze_pickaxe", avatarId: "bandit" },
      ),
    ).toEqual({ valid: true, reason: null });
  });

  it("rejects ambiguous or malformed competitive fit metadata", () => {
    const createWeapon = (compatibleAvatarIds: string[]) => {
      const model = new THREE.Group();
      model.userData.hyperia = {
        version: 2,
        vrmBoneName: "rightHand",
        relativeMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        duelFit: {
          schemaVersion: 1,
          itemId: "bronze_shortsword",
          slot: "weapon",
          compatibleAvatarIds,
        },
      };
      return model;
    };

    expect(
      validateStreamingEquipmentVisualModel(
        createWeapon(["bandit", "bandit"]),
        "weapon",
      ),
    ).toEqual({ valid: false, reason: "invalid_fit_metadata" });
    expect(
      validateStreamingEquipmentVisualModel(
        createWeapon([" bandit"]),
        "weapon",
      ),
    ).toEqual({ valid: false, reason: "invalid_fit_metadata" });
    const malformedItem = createWeapon(["bandit"]);
    malformedItem.userData.hyperia.duelFit.itemId = "../bronze_shortsword";
    expect(
      validateStreamingEquipmentVisualModel(malformedItem, "weapon"),
    ).toEqual({ valid: false, reason: "invalid_fit_metadata" });
  });

  it("accepts a skinned helmet only with a canonical fingerprint and matching rig", () => {
    const createSkinnedMesh = (skeleton: THREE.Skeleton) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute([0, 0, 0], 3),
      );
      geometry.setAttribute(
        "skinIndex",
        new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4),
      );
      geometry.setAttribute(
        "skinWeight",
        new THREE.Float32BufferAttribute([1, 0, 0, 0], 4),
      );
      const mesh = new THREE.SkinnedMesh(
        geometry,
        new THREE.MeshBasicMaterial(),
      );
      mesh.bind(skeleton, new THREE.Matrix4());
      return mesh;
    };
    const sourceBone = new THREE.Bone();
    sourceBone.name = "head";
    const sourceSkeleton = new THREE.Skeleton(
      [sourceBone],
      [new THREE.Matrix4()],
    );
    const helmet = new THREE.Group();
    helmet.userData.hyperia = {
      duelFit: {
        schemaVersion: 1,
        itemId: "bronze_full_helm",
        slot: "helmet",
        compatibleAvatarIds: ["bandit"],
        rigFingerprint: TEST_RIG_FINGERPRINT,
      },
    };
    helmet.add(createSkinnedMesh(sourceSkeleton));

    const targetBone = new THREE.Bone();
    targetBone.name = "head";
    const targetSkeleton = new THREE.Skeleton(
      [targetBone],
      [new THREE.Matrix4()],
    );
    const targetScene = new THREE.Group();
    targetScene.add(createSkinnedMesh(targetSkeleton));
    const vrm = { scene: targetScene } as unknown as VRM;

    expect(
      validateStreamingEquipmentVisualModel(helmet, "helmet", {
        itemId: "bronze_full_helm",
        avatarId: "bandit",
        vrm,
      }),
    ).toEqual({ valid: true, reason: null });

    helmet.userData.hyperia.duelFit.rigFingerprint = "not-a-sha256";
    expect(
      validateStreamingEquipmentVisualModel(helmet, "helmet", {
        itemId: "bronze_full_helm",
        avatarId: "bandit",
        vrm,
      }),
    ).toEqual({ valid: false, reason: "invalid_skinned_mesh" });
  });

  it("rejects skinned equipment exported against a different inverse bind pose", () => {
    const createSkinnedMesh = (skeleton: THREE.Skeleton): THREE.SkinnedMesh => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute([0, 0, 0], 3),
      );
      geometry.setAttribute(
        "skinIndex",
        new THREE.Uint16BufferAttribute([0, 0, 0, 0], 4),
      );
      geometry.setAttribute(
        "skinWeight",
        new THREE.Float32BufferAttribute([1, 0, 0, 0], 4),
      );
      const mesh = new THREE.SkinnedMesh(
        geometry,
        new THREE.MeshBasicMaterial(),
      );
      mesh.bind(skeleton);
      return mesh;
    };

    const sourceBone = new THREE.Bone();
    sourceBone.name = "hips";
    const sourceSkeleton = new THREE.Skeleton(
      [sourceBone],
      [new THREE.Matrix4()],
    );
    const model = new THREE.Group();
    model.userData.hyperia = {
      duelFit: {
        schemaVersion: 1,
        itemId: "bronze_platebody",
        slot: "body",
        compatibleAvatarIds: ["bandit"],
        rigFingerprint: TEST_RIG_FINGERPRINT,
      },
    };
    model.add(createSkinnedMesh(sourceSkeleton));

    const targetBone = new THREE.Bone();
    targetBone.name = "hips";
    const targetSkeleton = new THREE.Skeleton([targetBone]);
    const targetScene = new THREE.Group();
    const targetMesh = createSkinnedMesh(targetSkeleton);
    targetSkeleton.boneInverses[0].makeTranslation(0.25, 0, 0);
    targetScene.add(targetMesh);

    expect(
      validateStreamingEquipmentVisualModel(model, "body", {
        itemId: "bronze_platebody",
        avatarId: "bandit",
        vrm: { scene: targetScene } as unknown as VRM,
      }),
    ).toEqual({ valid: false, reason: "incompatible_skeleton" });
  });

  it("deduplicates concurrent warm-up and first-equip model work", async () => {
    const internals = system as unknown as {
      loadEquipmentModel: (
        itemId: string,
        slot: string,
        fallbackItemData: null,
      ) => Promise<unknown>;
    };

    await Promise.all([
      internals.loadEquipmentModel("bronze_longsword", "weapon", null),
      internals.loadEquipmentModel("bronze_longsword", "weapon", null),
    ]);

    expect(mockWorld.loader.loadFile).toHaveBeenCalledTimes(1);
  });

  it("rejects and evicts fitted bytes that do not match their declared identity", async () => {
    const expectedSha256 = "b".repeat(64);
    const itemData = {
      id: "content_mismatch_sword",
      modelPath: "asset://models/dropped.glb",
      equippedModelPath: "asset://models/content-mismatch.glb",
      equippedModelSha256: expectedSha256,
    } as unknown as ReturnType<typeof originalGetItem>;
    vi.mocked(itemsModule.getItem).mockReturnValueOnce(itemData);
    mockWorld.loader.clearCachedFile = vi.fn().mockResolvedValue(undefined);
    const internals = system as unknown as {
      loadEquipmentModel: (
        itemId: string,
        slot: string,
        fallbackItemData: null,
        avatarId?: string | null,
      ) => Promise<unknown>;
    };
    const resolvedUrl = `http://localhost:8080/assets/models/content-mismatch.glb?sha256=${expectedSha256}`;

    await expect(
      internals.loadEquipmentModel(
        "content_mismatch_sword",
        "weapon",
        null,
        "bandit",
      ),
    ).rejects.toThrow("Content SHA-256 mismatch");
    expect(mockWorld.loader.loadFile).toHaveBeenCalledWith(resolvedUrl);
    expect(mockWorld.loader.clearCachedFile).toHaveBeenCalledWith(resolvedUrl);
  });

  it("isolates fitted-model loads and cache entries by avatar rig", async () => {
    const itemData = {
      id: "avatar_specific_sword",
      modelPath: "asset://models/dropped.glb",
      equippedModelPath: "asset://models/steve-fitted.glb",
      equippedModelPathsByAvatar: {
        "kaykit-knight": "asset://models/kaykit-fitted.glb",
      },
    } as unknown as ReturnType<typeof originalGetItem>;
    vi.mocked(itemsModule.getItem)
      .mockReturnValueOnce(itemData)
      .mockReturnValueOnce(itemData);
    const internals = system as unknown as {
      loadEquipmentModel: (
        itemId: string,
        slot: string,
        fallbackItemData: null,
        avatarId?: string | null,
      ) => Promise<unknown>;
    };

    await internals.loadEquipmentModel(
      "avatar_specific_sword",
      "weapon",
      null,
      "steve",
    );
    await internals.loadEquipmentModel(
      "avatar_specific_sword",
      "weapon",
      null,
      "kaykit-knight",
    );
    await internals.loadEquipmentModel(
      "avatar_specific_sword",
      "weapon",
      null,
      "kaykit-knight",
    );

    expect(mockWorld.loader.loadFile).toHaveBeenCalledTimes(2);
    expect(mockWorld.loader.loadFile).toHaveBeenNthCalledWith(
      1,
      "http://localhost:8080/assets/models/steve-fitted.glb",
    );
    expect(mockWorld.loader.loadFile).toHaveBeenNthCalledWith(
      2,
      "http://localhost:8080/assets/models/kaykit-fitted.glb",
    );
  });

  it("should handle equipment change and equip item", async () => {
    // Trigger the event handler directly to test logic
    // We need to access the private method or bind the event handler
    // But since we mocked world.events.on, we can't easily trigger it through world.
    // Instead, we'll cast system to any to access private methods for testing

    const handler = (system as any).handleEquipmentChange.bind(system);

    await handler({
      playerId: "player1",
      slot: "mainHand",
      itemId: "bronze_sword",
    });

    // Verify GLTFLoader was called
    // We need to access the mocked loader instance
    // Since we mocked the module, we can check if loadAsync was called implicitly
    // However, checking the visual result is better

    // Check if player equipment map has entry
    const equipment = (system as any).playerEquipment.get("player1");
    expect(equipment).toBeDefined();
    expect(equipment.mainhand).toBeDefined(); // Slot name lowercased
  });

  it("should unequip item when itemId is null", async () => {
    const handler = (system as any).handleEquipmentChange.bind(system);

    // First equip
    await handler({
      playerId: "player1",
      slot: "mainHand",
      itemId: "bronze_sword",
    });

    let equipment = (system as any).playerEquipment.get("player1");
    expect(equipment.mainhand).toBeDefined();

    // Then unequip
    await handler({
      playerId: "player1",
      slot: "mainHand",
      itemId: null,
    });

    equipment = (system as any).playerEquipment.get("player1");
    expect(equipment.mainhand).toBeUndefined();
  });

  it("should queue equipment if player VRM is not ready", async () => {
    // Remove VRM from player
    mockPlayer._avatar.instance.raw.userData.vrm = undefined;

    const handler = (system as any).handleEquipmentChange.bind(system);

    await handler({
      playerId: "player1",
      slot: "mainHand",
      itemId: "bronze_sword",
    });

    // Check pending queue
    const pending = (system as any).pendingEquipment.get("player1");
    expect(pending).toBeDefined();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual({ slot: "mainHand", itemId: "bronze_sword" });
  });

  it("cancels queued equipment when authority unequips it before avatar readiness", async () => {
    mockPlayer._avatar.instance.raw.userData.vrm = undefined;
    const internals = system as any;

    await internals.handleEquipmentChange({
      playerId: "player1",
      slot: "weapon",
      itemId: "bronze_sword",
    });
    await internals.handleEquipmentChange({
      playerId: "player1",
      slot: "weapon",
      itemId: null,
    });

    expect(internals.pendingEquipment.has("player1")).toBe(false);

    mockPlayer._avatar.instance.raw.userData.vrm = mockVRM;
    const avatarReady = mockWorld.$eventBus.subscribe.mock.calls.find(
      ([registered]: [EventType]) =>
        registered === EventType.AVATAR_LOAD_COMPLETE,
    )?.[1] as ((event: unknown) => void) | undefined;
    avatarReady?.({
      data: { playerId: "player1", success: true },
    });
    await Promise.resolve();

    expect(internals.playerEquipment.get("player1")?.weapon).toBeUndefined();
    expect(
      internals.attachedEquipmentItemIds.get("player1")?.get("weapon"),
    ).toBeUndefined();
  });

  it("replaces queued slot authority case-insensitively", async () => {
    mockPlayer._avatar.instance.raw.userData.vrm = undefined;
    const internals = system as any;

    await internals.handleEquipmentChange({
      playerId: "player1",
      slot: "Weapon",
      itemId: "old_sword",
    });
    await internals.handleEquipmentChange({
      playerId: "player1",
      slot: "weapon",
      itemId: "replacement_sword",
    });

    expect(internals.pendingEquipment.get("player1")).toEqual([
      { slot: "weapon", itemId: "replacement_sword" },
    ]);
  });

  it("abandons an equipment load when its spectator entity leaves", async () => {
    let resolveFile: ((file: File) => void) | undefined;
    mockWorld.loader.loadFile.mockImplementationOnce(
      () =>
        new Promise<File>((resolve) => {
          resolveFile = resolve;
        }),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const handler = (system as any).handleEquipmentChange.bind(system);

    const pending = handler({
      playerId: "player1",
      slot: "weapon",
      itemId: "transition_race_sword",
    });
    mockWorld.entities.delete("player1");
    resolveFile?.(
      new File([new ArrayBuffer(8)], "transition-race.glb", {
        type: "model/gltf-binary",
      }),
    );
    await pending;

    expect(consoleError).not.toHaveBeenCalled();
    expect((system as any).playerEquipment.get("player1")).toEqual({});
  });

  it("cannot attach a stale model after a newer role switch wins the slot", async () => {
    const internals = system as unknown as {
      handleEquipmentChange: (data: {
        playerId: string;
        slot: string;
        itemId: string | null;
      }) => Promise<void>;
      loadEquipmentModel: (
        itemId: string,
        slot: string,
        fallbackItemData: unknown,
      ) => Promise<unknown>;
      attachedEquipmentItemIds: Map<string, Map<string, string>>;
    };
    const parsedModel = await internals.loadEquipmentModel(
      "replacement_sword",
      "weapon",
      null,
    );
    let resolveOld: ((model: unknown) => void) | undefined;
    internals.loadEquipmentModel = (itemId) =>
      itemId === "slow_old_sword"
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(parsedModel);

    const oldSwitch = internals.handleEquipmentChange({
      playerId: "player1",
      slot: "weapon",
      itemId: "slow_old_sword",
    });
    await internals.handleEquipmentChange({
      playerId: "player1",
      slot: "weapon",
      itemId: "replacement_sword",
    });
    resolveOld?.(parsedModel);
    await oldSwitch;

    expect(
      internals.attachedEquipmentItemIds.get("player1")?.get("weapon"),
    ).toBe("replacement_sword");
  });

  it("suppresses the weapon and shield while a gathering tool is active", async () => {
    const equipHandler = (system as any).handleEquipmentChange.bind(system);
    const showToolHandler = (system as any).handleGatheringToolShow.bind(
      system,
    );

    // Equip weapon first
    await equipHandler({
      playerId: "player1",
      slot: "weapon",
      itemId: "bronze_sword",
    });

    const equipment = (system as any).playerEquipment.get("player1");
    const weapon = equipment.weapon;
    const shield = new THREE.Object3D();
    equipment.shield = shield;
    expect(weapon.visible).toBe(true);
    expect(shield.visible).toBe(true);

    // Show gathering tool
    await showToolHandler({
      playerId: "player1",
      itemId: "fishing_rod",
      slot: "weapon",
    });

    // Weapon should be hidden
    expect(weapon.visible).toBe(false);
    expect(shield.visible).toBe(false);

    // Tool should be equipped in special slot
    expect(equipment.gatheringtool).toBeDefined();
  });

  it("restores the combat loadout when the gathering tool is hidden", async () => {
    const equipHandler = (system as any).handleEquipmentChange.bind(system);
    const showToolHandler = (system as any).handleGatheringToolShow.bind(
      system,
    );
    const hideToolHandler = (system as any).handleGatheringToolHide.bind(
      system,
    );

    // Equip weapon
    await equipHandler({
      playerId: "player1",
      slot: "weapon",
      itemId: "bronze_sword",
    });

    const equipment = (system as any).playerEquipment.get("player1");
    const weapon = equipment.weapon;
    const shield = new THREE.Object3D();
    equipment.shield = shield;

    // Show tool
    await showToolHandler({
      playerId: "player1",
      itemId: "fishing_rod",
      slot: "weapon",
    });

    expect(weapon.visible).toBe(false);
    expect(shield.visible).toBe(false);

    // Hide tool
    await hideToolHandler({
      playerId: "player1",
      slot: "weapon",
    });

    // Weapon should be visible again
    expect(weapon.visible).toBe(true);
    expect(shield.visible).toBe(true);
    // Tool should be removed
    expect(equipment.gatheringtool).toBeUndefined();
  });

  it("does not resurrect a hidden gathering tool after avatar readiness", async () => {
    const internals = system as any;
    await internals.handleEquipmentChange({
      playerId: "player1",
      slot: "weapon",
      itemId: "bronze_sword",
    });

    const equipment = internals.playerEquipment.get("player1");
    const shield = new THREE.Object3D();
    equipment.shield = shield;
    mockPlayer._avatar.instance.raw.userData.vrm = undefined;

    await internals.handleGatheringToolShow({
      playerId: "player1",
      itemId: "fishing_rod",
      slot: "weapon",
    });
    expect(equipment.weapon.visible).toBe(false);
    expect(shield.visible).toBe(false);

    internals.handleGatheringToolHide({
      playerId: "player1",
      slot: "weapon",
    });
    expect(equipment.weapon.visible).toBe(true);
    expect(shield.visible).toBe(true);

    mockPlayer._avatar.instance.raw.userData.vrm = mockVRM;
    const avatarReady = mockWorld.$eventBus.subscribe.mock.calls.find(
      ([registered]: [EventType]) =>
        registered === EventType.AVATAR_LOAD_COMPLETE,
    )?.[1] as ((event: unknown) => void) | undefined;
    avatarReady?.({
      data: { playerId: "player1", success: true },
    });
    await Promise.resolve();

    expect(internals.activeGatheringToolItemIds.has("player1")).toBe(false);
    expect(equipment.gatheringtool).toBeUndefined();
    expect(equipment.weapon.visible).toBe(true);
    expect(shield.visible).toBe(true);
  });

  it("replays only an active gathering tool when the avatar becomes ready", async () => {
    const internals = system as any;
    await internals.handleEquipmentChange({
      playerId: "player1",
      slot: "weapon",
      itemId: "bronze_sword",
    });
    const equipment = internals.playerEquipment.get("player1");
    const shield = new THREE.Object3D();
    equipment.shield = shield;
    mockPlayer._avatar.instance.raw.userData.vrm = undefined;

    await internals.handleGatheringToolShow({
      playerId: "player1",
      itemId: "fishing_rod",
      slot: "weapon",
    });
    mockPlayer._avatar.instance.raw.userData.vrm = mockVRM;

    const avatarReady = mockWorld.$eventBus.subscribe.mock.calls.find(
      ([registered]: [EventType]) =>
        registered === EventType.AVATAR_LOAD_COMPLETE,
    )?.[1] as ((event: unknown) => void) | undefined;
    avatarReady?.({
      data: { playerId: "player1", success: true },
    });

    await vi.waitFor(() => {
      expect(equipment.gatheringtool).toBeDefined();
    });
    expect(equipment.weapon.visible).toBe(false);
    expect(shield.visible).toBe(false);
    expect(equipment.gatheringtool.visible).toBe(true);
  });

  it("hydrates an active gathering tool from versioned entity snapshot authority", async () => {
    const internals = system as any;
    mockPlayer.data.gatheringToolPresentation = {
      revision: 7,
      itemId: "fishing_rod",
    };
    mockPlayer._avatar.instance.raw.userData.vrm = mockVRM;

    const avatarReady = mockWorld.$eventBus.subscribe.mock.calls.find(
      ([registered]: [EventType]) =>
        registered === EventType.AVATAR_LOAD_COMPLETE,
    )?.[1] as ((event: unknown) => void) | undefined;
    avatarReady?.({
      data: { playerId: "player1", success: true },
    });

    await vi.waitFor(() => {
      expect(internals.activeGatheringToolItemIds.get("player1")).toBe(
        "fishing_rod",
      );
      expect(
        internals.playerEquipment.get("player1")?.gatheringtool?.visible,
      ).toBe(true);
    });
    expect(
      internals.latestGatheringToolPresentationRevisions.get("player1"),
    ).toBe(7);
  });

  it("reports fail-closed preparation visual readiness for the current avatar", async () => {
    const internals = system as any;
    expect(
      system.getStreamingPreparationVisualDiagnostics(["player1"]),
    ).toMatchObject({
      activeCount: 0,
      readyCount: 0,
      ready: false,
    });
    expect(system.isStreamingPreparationPresentationActive("player1")).toBe(
      false,
    );

    const heldHarpoon = new THREE.Object3D();
    internals.activeGatheringToolItemIds.set("player1", "harpoon");
    internals.latestGatheringToolPresentationRevisions.set("player1", 11);
    internals.fishingInteractionStates.set("player1", {
      revision: 12,
      interactionId: "fishing:harpoon-proof",
      resourceId: "fish_-6_-13",
      itemId: "harpoon",
      phase: "held",
      outcome: "none",
      attempt: 1,
      serverTick: 75,
      targetPosition: { x: -5.5, y: 27.8, z: -12.5 },
    });
    internals.latestFishingInteractionPresentationRevisions.set("player1", 12);
    internals.desiredEquipmentItemIds.set(
      "player1",
      new Map([["gatheringtool", "harpoon"]]),
    );
    internals.attachedEquipmentItemIds.set(
      "player1",
      new Map([["gatheringtool", "harpoon"]]),
    );
    internals.attachedEquipmentAvatarVrms.set(
      "player1",
      new Map([["gatheringtool", mockVRM]]),
    );
    internals.playerEquipment.set("player1", {
      gatheringtool: heldHarpoon,
    });
    expect(system.isStreamingPreparationPresentationActive("player1")).toBe(
      true,
    );
    expect(
      system.getStreamingPreparationActivityTargetPosition(["player1"]),
    ).toEqual({ x: -5.5, y: 27.8, z: -12.5 });

    expect(
      system.getStreamingPreparationVisualDiagnostics(["player1"]),
    ).toMatchObject({
      activeCount: 1,
      readyCount: 1,
      ready: true,
      players: [
        {
          playerId: "player1",
          presentationActive: true,
          gatheringToolItemId: "harpoon",
          fishingPhase: "held",
          desiredItemId: "harpoon",
          attachedItemId: "harpoon",
          heldVisualPresent: true,
          heldVisualVisible: true,
          worldVisualPresent: false,
          worldVisualVisible: false,
          attachedToCurrentAvatar: true,
          gatheringRevision: 11,
          fishingRevision: 12,
          ready: true,
        },
      ],
    });

    mockPlayer._avatar.instance.raw.userData.vrm = { ...mockVRM };
    expect(
      system.getStreamingPreparationVisualDiagnostics(["player1"]),
    ).toMatchObject({
      activeCount: 1,
      readyCount: 0,
      ready: false,
      players: [{ attachedToCurrentAvatar: false, ready: false }],
    });
  });

  it("hydrates processing state and fails closed for an uncertified station motion", () => {
    const internals = system as any;
    mockPlayer.data.processingInteractionPresentation = {
      revision: 21,
      skill: "smithing",
      phase: "working",
      phaseStartedAtServerTimeMs: 8000,
      targetPosition: { x: 3, y: 0, z: -2 },
    };
    mockPlayer._avatar.instance.raw.userData.vrm = mockVRM;
    const avatarReady = mockWorld.$eventBus.subscribe.mock.calls.find(
      ([registered]: [EventType]) =>
        registered === EventType.AVATAR_LOAD_COMPLETE,
    )?.[1] as ((event: unknown) => void) | undefined;
    avatarReady?.({ data: { playerId: "player1", success: true } });

    expect(
      system.getStreamingPreparationActivityTargetPosition(["player1"]),
    ).toEqual({ x: 3, y: 0, z: -2 });
    expect(
      system.getStreamingPreparationVisualDiagnostics(["player1"]),
    ).toMatchObject({
      activeCount: 1,
      readyCount: 0,
      ready: false,
      players: [
        {
          processingSkill: "smithing",
          processingPhase: "working",
          processingRevision: 21,
          processingTargetPosition: { x: 3, y: 0, z: -2 },
          processingBodyEmote: null,
          processingBodyMotionReady: false,
          processingTargetReady: true,
          ready: false,
        },
      ],
    });

    internals.handleProcessingInteractionPresentation({
      playerId: "player1",
      revision: 20,
      skill: "cooking",
      phase: "working",
      phaseStartedAtServerTimeMs: 9000,
      targetPosition: { x: 9, y: 0, z: 9 },
    });
    expect(internals.processingInteractionStates.get("player1").skill).toBe(
      "smithing",
    );
  });

  it("marks a reviewed cooking body motion and exact source target ready", () => {
    const internals = system as any;
    mockPlayer.data.e = "squat";
    internals.handleProcessingInteractionPresentation({
      playerId: "player1",
      revision: 30,
      skill: "cooking",
      phase: "working",
      phaseStartedAtServerTimeMs: 9000,
      targetPosition: { x: 1, y: 0, z: 1 },
    });
    expect(
      system.getStreamingPreparationVisualDiagnostics(["player1"]),
    ).toMatchObject({
      activeCount: 1,
      readyCount: 1,
      ready: true,
      players: [
        {
          processingBodyEmote: "squat",
          processingBodyMotionReady: true,
          processingTargetReady: true,
          ready: true,
        },
      ],
    });
  });

  it("rejects stale gathering-tool show and hide transitions", async () => {
    const internals = system as any;

    await internals.handleGatheringToolShow({
      playerId: "player1",
      itemId: "fishing_rod",
      slot: "weapon",
      revision: 10,
    });
    internals.handleGatheringToolHide({
      playerId: "player1",
      slot: "weapon",
      revision: 11,
    });
    await internals.handleGatheringToolShow({
      playerId: "player1",
      itemId: "stale_hatchet",
      slot: "weapon",
      revision: 10,
    });
    expect(internals.activeGatheringToolItemIds.has("player1")).toBe(false);

    await internals.handleGatheringToolShow({
      playerId: "player1",
      itemId: "replacement_pickaxe",
      slot: "weapon",
      revision: 12,
    });
    internals.handleGatheringToolHide({
      playerId: "player1",
      slot: "weapon",
      revision: 11,
    });

    expect(internals.activeGatheringToolItemIds.get("player1")).toBe(
      "replacement_pickaxe",
    );
    expect(
      internals.attachedEquipmentItemIds.get("player1")?.get("gatheringtool"),
    ).toBe("replacement_pickaxe");
    expect(
      internals.latestGatheringToolPresentationRevisions.get("player1"),
    ).toBe(12);
  });

  it("discards a slow gathering-tool load after the session ends", async () => {
    const internals = system as any;
    await internals.handleEquipmentChange({
      playerId: "player1",
      slot: "weapon",
      itemId: "bronze_sword",
    });
    const equipment = internals.playerEquipment.get("player1");
    const shield = new THREE.Object3D();
    equipment.shield = shield;
    let resolveTool: ((model: unknown) => void) | undefined;
    internals.loadEquipmentModel = (itemId: string) =>
      itemId === "fishing_rod"
        ? new Promise((resolve) => {
            resolveTool = resolve;
          })
        : Promise.resolve(null);

    const showing = internals.handleGatheringToolShow({
      playerId: "player1",
      itemId: "fishing_rod",
      slot: "weapon",
    });
    internals.handleGatheringToolHide({
      playerId: "player1",
      slot: "weapon",
    });
    resolveTool?.({ scene: new THREE.Group() });
    await showing;

    expect(equipment.gatheringtool).toBeUndefined();
    expect(equipment.weapon.visible).toBe(true);
    expect(shield.visible).toBe(true);
  });

  it("keeps only the newest gathering tool when model loads finish out of order", async () => {
    const internals = system as any;
    const parsedModel = await internals.loadEquipmentModel(
      "replacement_pickaxe",
      "gatheringTool",
      null,
    );
    let resolveOld: ((model: unknown) => void) | undefined;
    internals.loadEquipmentModel = (itemId: string) =>
      itemId === "slow_old_hatchet"
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(parsedModel);

    const oldShow = internals.handleGatheringToolShow({
      playerId: "player1",
      itemId: "slow_old_hatchet",
      slot: "weapon",
    });
    await internals.handleGatheringToolShow({
      playerId: "player1",
      itemId: "replacement_pickaxe",
      slot: "weapon",
    });
    resolveOld?.(parsedModel);
    await oldShow;

    expect(internals.activeGatheringToolItemIds.get("player1")).toBe(
      "replacement_pickaxe",
    );
    expect(
      internals.attachedEquipmentItemIds.get("player1")?.get("gatheringtool"),
    ).toBe("replacement_pickaxe");
    expect(
      internals.playerEquipment.get("player1")?.gatheringtool?.visible,
    ).toBe(true);
  });

  it("cannot let a hidden old tool replace a newer gathering session", async () => {
    const internals = system as any;
    const parsedModel = await internals.loadEquipmentModel(
      "replacement_pickaxe",
      "gatheringTool",
      null,
    );
    let resolveOld: ((model: unknown) => void) | undefined;
    internals.loadEquipmentModel = (itemId: string) =>
      itemId === "slow_old_hatchet"
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(parsedModel);

    const oldShow = internals.handleGatheringToolShow({
      playerId: "player1",
      itemId: "slow_old_hatchet",
      slot: "weapon",
    });
    internals.handleGatheringToolHide({
      playerId: "player1",
      slot: "weapon",
    });
    await internals.handleGatheringToolShow({
      playerId: "player1",
      itemId: "replacement_pickaxe",
      slot: "weapon",
    });
    resolveOld?.(parsedModel);
    await oldShow;

    expect(internals.activeGatheringToolItemIds.get("player1")).toBe(
      "replacement_pickaxe",
    );
    expect(
      internals.attachedEquipmentItemIds.get("player1")?.get("gatheringtool"),
    ).toBe("replacement_pickaxe");
    expect(
      internals.playerEquipment.get("player1")?.gatheringtool?.visible,
    ).toBe(true);
  });

  it("renders exact net world phases and rejects stale resurrection", async () => {
    const internals = system as any;
    const heldTool = new THREE.Group();
    heldTool.position.set(2, 1.1, 3);
    const fittedWrapper = new THREE.Group();
    fittedWrapper.name = "EquipmentWrapper";
    fittedWrapper.position.set(0.2, 0.3, -0.1);
    fittedWrapper.rotation.y = Math.PI / 3;
    fittedWrapper.scale.setScalar(0.75);
    const heldGeometryMarker = new THREE.Group();
    heldGeometryMarker.name = "HeldGeometryMarker";
    fittedWrapper.add(heldGeometryMarker);
    heldTool.add(fittedWrapper);
    mockWorld.stage.scene.add(heldTool);
    const equipment = { gatheringtool: heldTool };
    internals.playerEquipment.set("player1", equipment);
    internals.activeGatheringToolItemIds.set("player1", "small_fishing_net");

    const source = new THREE.Group();
    const worldGeometryMarker = new THREE.Group();
    worldGeometryMarker.name = "WorldGeometryMarker";
    source.add(worldGeometryMarker);
    source.userData.hyperia = {
      fishingWorld: {
        schemaVersion: 1,
        itemId: "small_fishing_net",
        placement: {
          positionOffset: [0, 0.02, 0.66],
          rotationEulerDegrees: [-90, 0, 0],
          scale: 1,
        },
      },
    };
    internals.loadFishingWorldModel = vi
      .fn()
      .mockResolvedValue({ scene: source });

    const base = {
      playerId: "player1",
      interactionId: "fishing:session-1",
      resourceId: "fishing_spot_net_1",
      itemId: "small_fishing_net",
      outcome: "none",
      attempt: 0,
      serverTick: 20,
      targetPosition: { x: 10, y: 0.25, z: 12 },
    };
    await internals.handleFishingInteractionPresentation({
      ...base,
      revision: 1,
      phase: "released",
    });

    const released = internals.fishingWorldProps.get("player1");
    expect(released.object.parent).toBe(mockWorld.stage.scene);
    expect(released.transition.kind).toBe("release");
    expect(released.transition.durationMs).toBe(600);
    expect(released.transition.transferDelayMs).toBe(180);
    expect(released.transition.arcHeightMetres).toBe(0.35);
    expect(released.visualKind).toBe("held_clone");
    expect(released.object.getObjectByName("HeldGeometryMarker")).toBeTruthy();
    expect(
      released.object.getObjectByName("WorldGeometryMarker"),
    ).toBeUndefined();
    expect(
      released.object.position.distanceTo(new THREE.Vector3(2.2, 1.4, 2.9)),
    ).toBeLessThan(1e-12);
    expect(
      released.object.quaternion.angleTo(fittedWrapper.quaternion),
    ).toBeLessThan(1e-6);
    expect(
      released.object.scale.distanceTo(new THREE.Vector3(0.75, 0.75, 0.75)),
    ).toBeLessThan(1e-12);
    expect(heldTool.visible).toBe(false);

    const releaseTransition = released.transition;
    internals.applyFishingWorldTransition(
      "player1",
      released,
      releaseTransition.startedAtPerformanceMs + 600,
    );
    expect(released.object.position.toArray()).toEqual([10, 0.27, 12.66]);
    expect(released.object.rotation.x).toBeCloseTo(-Math.PI / 2);
    expect(released.object.scale.toArray()).toEqual([1, 1, 1]);
    expect(released.transition).toBeNull();

    await internals.handleFishingInteractionPresentation({
      ...base,
      revision: 2,
      phase: "deployed",
      serverTick: 21,
    });
    expect(released.visualKind).toBe("world_model");
    expect(
      released.object.getObjectByName("HeldGeometryMarker"),
    ).toBeUndefined();
    expect(released.object.getObjectByName("WorldGeometryMarker")).toBeTruthy();
    expect(released.object.position.toArray()).toEqual([10, 0.27, 12.66]);
    expect(released.object.rotation.x).toBeCloseTo(-Math.PI / 2);

    await internals.handleFishingInteractionPresentation({
      playerId: "player1",
      revision: 3,
      interactionId: null,
      resourceId: null,
      itemId: null,
      phase: "idle",
      outcome: "none",
      attempt: 0,
      serverTick: 22,
      targetPosition: null,
    });
    expect(internals.fishingWorldProps.has("player1")).toBe(false);
    expect(released.object.parent).toBeNull();
    expect(heldTool.visible).toBe(true);

    await internals.handleFishingInteractionPresentation({
      ...base,
      revision: 2,
      phase: "deployed",
      serverTick: 21,
    });
    expect(internals.fishingWorldProps.has("player1")).toBe(false);
  });

  it("cannot resurrect a world prop when its model finishes loading after session cleanup", async () => {
    const internals = system as any;
    const heldTool = new THREE.Group();
    internals.playerEquipment.set("player1", { gatheringtool: heldTool });
    internals.activeGatheringToolItemIds.set("player1", "lobster_pot");

    const source = new THREE.Group();
    source.userData.hyperia = {
      fishingWorld: {
        schemaVersion: 1,
        itemId: "lobster_pot",
        placement: {
          positionOffset: [0, 0, 0],
          rotationEulerDegrees: [0, 0, 0],
          scale: 1,
        },
      },
    };
    let resolveModel: ((model: { scene: THREE.Group }) => void) | undefined;
    internals.loadFishingWorldModel = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveModel = resolve;
        }),
    );

    const loading = internals.handleFishingInteractionPresentation({
      playerId: "player1",
      revision: 10,
      interactionId: "fishing:slow-session",
      resourceId: "fishing_spot_pot_1",
      itemId: "lobster_pot",
      phase: "deployed",
      outcome: "none",
      attempt: 0,
      serverTick: 40,
      targetPosition: { x: 4, y: 0.2, z: 8 },
    });
    await Promise.resolve();

    await internals.handleFishingInteractionPresentation({
      playerId: "player1",
      revision: 11,
      interactionId: null,
      resourceId: null,
      itemId: null,
      phase: "idle",
      outcome: "none",
      attempt: 0,
      serverTick: 41,
      targetPosition: null,
    });
    resolveModel?.({ scene: source });
    await loading;

    expect(internals.fishingWorldProps.has("player1")).toBe(false);
    expect(mockWorld.stage.scene.children).not.toContain(source);
    expect(heldTool.visible).toBe(true);
  });

  it("hydrates a deployed fishing prop from late-join entity snapshot authority", async () => {
    const internals = system as any;
    const source = new THREE.Group();
    source.userData.hyperia = {
      fishingWorld: {
        schemaVersion: 1,
        itemId: "small_fishing_net",
        placement: {
          positionOffset: [0, 0.02, 0.66],
          rotationEulerDegrees: [-90, 0, 0],
          scale: 1,
        },
      },
    };
    internals.loadFishingWorldModel = vi
      .fn()
      .mockResolvedValue({ scene: source });
    mockPlayer.data.gatheringToolPresentation = {
      revision: 6,
      itemId: "small_fishing_net",
    };
    mockPlayer.data.fishingInteractionPresentation = {
      revision: 7,
      interactionId: "fishing:snapshot-session",
      resourceId: "fishing_spot_net_2",
      itemId: "small_fishing_net",
      phase: "deployed",
      outcome: "none",
      attempt: 1,
      serverTick: 75,
      targetPosition: { x: 15, y: 0.3, z: -4 },
    };

    const avatarReady = mockWorld.$eventBus.subscribe.mock.calls.find(
      ([registered]: [EventType]) =>
        registered === EventType.AVATAR_LOAD_COMPLETE,
    )?.[1] as ((event: unknown) => void) | undefined;
    avatarReady?.({
      data: { playerId: "player1", success: true },
    });

    await vi.waitFor(() => {
      expect(internals.fishingWorldProps.has("player1")).toBe(true);
      expect(internals.activeGatheringToolItemIds.get("player1")).toBe(
        "small_fishing_net",
      );
    });
    const hydrated = internals.fishingWorldProps.get("player1");
    expect(hydrated.object.parent).toBe(mockWorld.stage.scene);
    expect(hydrated.object.position.toArray()).toEqual([15, 0.32, -3.34]);
    expect(
      internals.latestFishingInteractionPresentationRevisions.get("player1"),
    ).toBe(7);
  });

  it("starts a late-join retrieval at the authoritative water target", async () => {
    const internals = system as any;
    const heldTool = new THREE.Group();
    const fittedWrapper = new THREE.Group();
    fittedWrapper.name = "EquipmentWrapper";
    const heldGeometryMarker = new THREE.Group();
    heldGeometryMarker.name = "HeldGeometryMarker";
    fittedWrapper.add(heldGeometryMarker);
    heldTool.add(fittedWrapper);
    mockWorld.stage.scene.add(heldTool);
    internals.playerEquipment.set("player1", { gatheringtool: heldTool });
    const source = new THREE.Group();
    source.position.set(99, 98, 97);
    source.userData.hyperia = {
      fishingWorld: {
        schemaVersion: 1,
        itemId: "lobster_pot",
        placement: {
          positionOffset: [0, 0, 0],
          rotationEulerDegrees: [0, 0, 0],
          scale: 1,
        },
      },
    };
    internals.loadFishingWorldModel = vi
      .fn()
      .mockResolvedValue({ scene: source });

    await internals.handleFishingInteractionPresentation({
      playerId: "player1",
      revision: 4,
      interactionId: "fishing:late-retrieval",
      resourceId: "fishing_spot_pot_4",
      itemId: "lobster_pot",
      phase: "retrieving",
      outcome: "caught",
      attempt: 2,
      serverTick: 90,
      targetPosition: { x: 6, y: 0.2, z: 9 },
    });

    const prop = internals.fishingWorldProps.get("player1");
    expect(prop.transition.kind).toBe("retrieve");
    expect(prop.transition.durationMs).toBe(1200);
    expect(prop.transition.transferDelayMs).toBe(420);
    expect(prop.transition.from.toArray()).toEqual([6, 0.2, 9]);
    expect(prop.object.position.toArray()).toEqual([6, 0.2, 9]);
    expect(prop.visualKind).toBe("world_model");

    const transition = prop.transition;
    internals.applyFishingWorldTransition(
      "player1",
      prop,
      transition.startedAtPerformanceMs + 419,
    );
    expect(prop.object.position.toArray()).toEqual([6, 0.2, 9]);
    internals.applyFishingWorldTransition(
      "player1",
      prop,
      transition.startedAtPerformanceMs + 1200,
    );
    expect(prop.visualKind).toBe("held_clone");
    expect(prop.object.getObjectByName("HeldGeometryMarker")).toBeTruthy();
    expect(prop.object.position.toArray()).toEqual(
      fittedWrapper.getWorldPosition(new THREE.Vector3()).toArray(),
    );
    expect(prop.transition).toBeNull();
  });
});

describe("fishing world visual metadata", () => {
  it("accepts exact placement metadata and rejects item mismatch", () => {
    const root = new THREE.Group();
    root.userData.hyperia = {
      fishingWorld: {
        schemaVersion: 1,
        itemId: "lobster_pot",
        placement: {
          positionOffset: [0, 0, 0],
          rotationEulerDegrees: [0, 0, 0],
          scale: 1,
        },
      },
    };
    expect(extractFishingWorldVisualPlacement(root, "lobster_pot")).toEqual({
      positionOffset: [0, 0, 0],
      rotationEulerDegrees: [0, 0, 0],
      scale: 1,
    });
    expect(
      extractFishingWorldVisualPlacement(root, "small_fishing_net"),
    ).toBeNull();
  });
});

describe("held-equipment death visibility", () => {
  it("keeps held equipment visible during ordinary and combat emotes", () => {
    expect(shouldRenderHeldEquipmentVisual({ emote: "idle" })).toBe(true);
    expect(shouldRenderHeldEquipmentVisual({ emote: "range" })).toBe(true);
    expect(
      shouldRenderHeldEquipmentVisual({
        emote: "spell_cast",
        deathState: "alive",
      }),
    ).toBe(true);
  });

  it("hides held equipment for every authoritative death signal", () => {
    expect(shouldRenderHeldEquipmentVisual({ emote: "death" })).toBe(false);
    expect(shouldRenderHeldEquipmentVisual({ abbreviatedEmote: "death" })).toBe(
      false,
    );
    expect(shouldRenderHeldEquipmentVisual({ deathState: "dying" })).toBe(
      false,
    );
    expect(shouldRenderHeldEquipmentVisual({ deathState: "dead" })).toBe(false);
  });

  it("hides held equipment during the two-hands-up victory presentation", () => {
    expect(shouldRenderHeldEquipmentVisual({ emote: "victory" })).toBe(false);
    expect(
      shouldRenderHeldEquipmentVisual({ abbreviatedEmote: "victory" }),
    ).toBe(false);
  });
});

describe("stable fitted staff pose", () => {
  const createStaff = () => {
    const root = new THREE.Group();
    root.userData.hyperia = {
      version: 2,
      vrmBoneName: "rightHand",
      relativeMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      weaponType: "staff",
      duelFit: {
        schemaVersion: 1,
        itemId: "staff_of_air",
        slot: "weapon",
        compatibleAvatarIds: ["steve"],
      },
      stableHeldPose: {
        schemaVersion: 1,
        wrapperNodeName: "EquipmentWrapper",
        avatarLocalEulerDegrees: [0, 0, 18],
      },
    };
    const wrapper = new THREE.Group();
    wrapper.name = "EquipmentWrapper";
    wrapper.position.set(0.1, 0.2, 0.3);
    wrapper.quaternion.setFromEuler(new THREE.Euler(0.2, -0.4, 0.1));
    wrapper.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 1.3, 0.05),
        new THREE.MeshBasicMaterial(),
      ),
    );
    root.add(wrapper);
    return { root, wrapper };
  };

  it("fails closed when a fitted staff has no valid stable-pose authority", () => {
    const { root } = createStaff();
    delete root.userData.hyperia.stableHeldPose;
    expect(
      validateStreamingEquipmentVisualModel(root, "weapon", {
        itemId: "staff_of_air",
        avatarId: "steve",
      }),
    ).toEqual({ valid: false, reason: "invalid_stable_held_pose" });

    root.userData.hyperia.stableHeldPose = {
      schemaVersion: 1,
      wrapperNodeName: "EquipmentWrapper",
      avatarLocalEulerDegrees: [0, 0, 181],
    };
    expect(
      validateStreamingEquipmentVisualModel(root, "weapon", {
        itemId: "staff_of_air",
        avatarId: "steve",
      }),
    ).toEqual({ valid: false, reason: "invalid_stable_held_pose" });
  });

  it("rejects malformed optional stable-pose metadata on any rigid weapon", () => {
    const { root } = createStaff();
    root.userData.hyperia.weaponType = "sword";
    root.userData.hyperia.duelFit.itemId = "bronze_shortsword";
    root.userData.hyperia.stableHeldPose.avatarLocalEulerDegrees = [
      0,
      0,
      Number.NaN,
    ];
    expect(
      validateStreamingEquipmentVisualModel(root, "weapon", {
        itemId: "bronze_shortsword",
        avatarId: "steve",
      }),
    ).toEqual({ valid: false, reason: "invalid_stable_held_pose" });
  });

  it("cancels wrist roll while preserving grip position and avatar facing", () => {
    const { root, wrapper } = createStaff();
    const avatarScene = new THREE.Group();
    avatarScene.rotation.y = 0.7;
    const rightHand = new THREE.Object3D();
    rightHand.position.set(0.4, 1, -0.2);
    rightHand.rotation.set(0.8, -0.3, 1.1);
    avatarScene.add(rightHand);
    rightHand.add(root);
    avatarScene.updateMatrixWorld(true);
    const originalPosition = wrapper.position.clone();
    const originalQuaternion = wrapper.quaternion.clone();
    const mesh = wrapper.children[0] as THREE.Mesh;
    const originalRenderHook = vi.fn();
    mesh.onBeforeRender = originalRenderHook;

    const controller = createStableHeldEquipmentPoseController({
      modelRoot: root,
      vrm: { scene: avatarScene } as unknown as VRM,
    });
    expect(controller).not.toBeNull();

    const expectedAvatarLocal = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, 0, THREE.MathUtils.degToRad(18)),
    );
    const expectedWorld = avatarScene
      .getWorldQuaternion(new THREE.Quaternion())
      .multiply(expectedAvatarLocal);
    expect(
      wrapper.getWorldQuaternion(new THREE.Quaternion()).angleTo(expectedWorld),
    ).toBeLessThan(1e-7);
    expect(wrapper.position.distanceTo(originalPosition)).toBe(0);

    rightHand.rotation.set(-1.2, 0.9, -0.6);
    avatarScene.rotation.y = -0.45;
    avatarScene.updateMatrixWorld(true);
    controller!.update();
    const rotatedExpected = avatarScene
      .getWorldQuaternion(new THREE.Quaternion())
      .multiply(expectedAvatarLocal);
    expect(
      wrapper
        .getWorldQuaternion(new THREE.Quaternion())
        .angleTo(rotatedExpected),
    ).toBeLessThan(1e-7);
    expect(wrapper.position.distanceTo(originalPosition)).toBe(0);

    mesh.onBeforeRender(
      {} as THREE.WebGLRenderer,
      {} as THREE.Scene,
      {} as THREE.Camera,
      {} as THREE.BufferGeometry,
      {} as THREE.Material,
      {} as THREE.Group,
    );
    expect(originalRenderHook).toHaveBeenCalledOnce();

    controller!.dispose();
    expect(wrapper.quaternion.angleTo(originalQuaternion)).toBeLessThan(1e-7);
    expect(mesh.onBeforeRender).toBe(originalRenderHook);
  });

  it("anchors an authored wrapper origin to the rendered hand grip", () => {
    const { root, wrapper } = createStaff();
    root.userData.hyperia.stableHeldPose.primaryBoneLocalOffset = [
      0.04, 0.15, -0.02,
    ];
    root.userData.hyperia.stableHeldPose.avatarLocalPositionOffset = [
      0.05, 0, 0.005,
    ];
    const avatarScene = new THREE.Group();
    avatarScene.rotation.y = 0.35;
    const rightHand = new THREE.Object3D();
    rightHand.position.set(0.4, 1, -0.2);
    rightHand.rotation.set(0.2, -0.4, 0.6);
    avatarScene.add(rightHand);
    rightHand.add(root);
    avatarScene.updateMatrixWorld(true);
    const controller = createStableHeldEquipmentPoseController({
      modelRoot: root,
      vrm: {
        scene: avatarScene,
        humanoid: {
          getRawBoneNode: (name: string) =>
            name === "rightHand" ? rightHand : null,
        },
      } as unknown as VRM,
    });
    expect(controller).not.toBeNull();
    const expectedGrip = rightHand
      .localToWorld(new THREE.Vector3(0.04, 0.15, -0.02))
      .add(
        new THREE.Vector3(0.05, 0, 0.005).applyQuaternion(
          avatarScene.getWorldQuaternion(new THREE.Quaternion()),
        ),
      );
    expect(
      wrapper.getWorldPosition(new THREE.Vector3()).distanceTo(expectedGrip),
    ).toBeLessThan(1e-7);

    rightHand.position.set(-0.2, 1.3, 0.5);
    rightHand.rotation.set(-0.5, 0.7, -0.3);
    avatarScene.updateMatrixWorld(true);
    controller!.update();
    const movedGrip = rightHand
      .localToWorld(new THREE.Vector3(0.04, 0.15, -0.02))
      .add(
        new THREE.Vector3(0.05, 0, 0.005).applyQuaternion(
          avatarScene.getWorldQuaternion(new THREE.Quaternion()),
        ),
      );
    expect(
      wrapper.getWorldPosition(new THREE.Vector3()).distanceTo(movedGrip),
    ).toBeLessThan(1e-7);
  });
});

describe("dynamic two-hand equipment grip", () => {
  const createHarpoon = () => {
    const root = new THREE.Group();
    root.userData.hyperia = {
      version: 2,
      vrmBoneName: "rightHand",
      relativeMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      weaponType: "harpoon",
      duelFit: {
        schemaVersion: 1,
        itemId: "harpoon",
        slot: "gatheringtool",
        compatibleAvatarIds: ["steve"],
      },
      twoHandGrip: {
        schemaVersion: 1,
        wrapperNodeName: "EquipmentWrapper",
        sourceHandleAxis: [0, 1, 0],
        secondaryBoneName: "leftHand",
        secondaryBoneLocalOffset: [0.05, 0.1, -0.2],
      },
    };
    const wrapper = new THREE.Group();
    wrapper.name = "EquipmentWrapper";
    wrapper.position.set(0.02, 0.03, -0.01);
    wrapper.quaternion.setFromEuler(new THREE.Euler(0.2, -0.4, 0.1));
    wrapper.add(
      new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, 1.5, 8),
        new THREE.MeshBasicMaterial(),
      ),
    );
    root.add(wrapper);
    return { root, wrapper };
  };

  it("fails closed when a harpoon lacks valid off-hand authority", () => {
    const { root } = createHarpoon();
    delete root.userData.hyperia.twoHandGrip;
    expect(
      validateStreamingEquipmentVisualModel(root, "gatheringtool", {
        itemId: "harpoon",
        avatarId: "steve",
      }),
    ).toEqual({ valid: false, reason: "invalid_two_hand_grip" });
  });

  it("keeps the shaft on the animated off hand without moving the primary grip", () => {
    const { root, wrapper } = createHarpoon();
    const avatarScene = new THREE.Group();
    const rightHand = new THREE.Object3D();
    const leftHand = new THREE.Object3D();
    rightHand.position.set(0.4, 1, -0.2);
    leftHand.position.set(-0.25, 1.25, 0.3);
    avatarScene.add(rightHand, leftHand);
    rightHand.add(root);
    avatarScene.updateMatrixWorld(true);
    const originalPosition = wrapper.position.clone();
    const originalQuaternion = wrapper.quaternion.clone();
    const mesh = wrapper.children[0] as THREE.Mesh;
    const originalRenderHook = vi.fn();
    mesh.onBeforeRender = originalRenderHook;
    const vrm = {
      scene: avatarScene,
      humanoid: {
        getRawBoneNode: (name: string) =>
          name === "leftHand"
            ? leftHand
            : name === "rightHand"
              ? rightHand
              : null,
      },
    } as unknown as VRM;

    const controller = createTwoHandEquipmentGripController({
      modelRoot: root,
      vrm,
    });
    expect(controller).not.toBeNull();
    const alignmentError = () => {
      avatarScene.updateMatrixWorld(true);
      const shaftAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(
        wrapper.getWorldQuaternion(new THREE.Quaternion()),
      );
      const desiredAxis = leftHand
        .localToWorld(new THREE.Vector3(0.05, 0.1, -0.2))
        .sub(wrapper.getWorldPosition(new THREE.Vector3()));
      return shaftAxis.normalize().angleTo(desiredAxis.normalize());
    };
    expect(alignmentError()).toBeLessThan(1e-7);
    expect(wrapper.position.distanceTo(originalPosition)).toBe(0);

    rightHand.rotation.set(-0.7, 0.8, 0.3);
    leftHand.position.set(0.05, 0.75, -0.65);
    controller!.update();
    expect(alignmentError()).toBeLessThan(1e-7);
    expect(wrapper.position.distanceTo(originalPosition)).toBe(0);

    mesh.onBeforeRender(
      {} as THREE.WebGLRenderer,
      {} as THREE.Scene,
      {} as THREE.Camera,
      {} as THREE.BufferGeometry,
      {} as THREE.Material,
      {} as THREE.Group,
    );
    expect(originalRenderHook).toHaveBeenCalledOnce();

    controller!.dispose();
    expect(wrapper.quaternion.angleTo(originalQuaternion)).toBeLessThan(1e-7);
    expect(mesh.onBeforeRender).toBe(originalRenderHook);
  });
});

describe("dynamic competitive bowstring", () => {
  const createBow = () => {
    const root = new THREE.Group();
    root.userData.hyperia = {
      version: 2,
      vrmBoneName: "leftHand",
      relativeMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      weaponType: "bow",
      duelFit: {
        schemaVersion: 1,
        itemId: "shortbow",
        slot: "weapon",
        compatibleAvatarIds: ["steve"],
      },
      bowString: {
        schemaVersion: 1,
        contentNodeName: "EquipmentContent",
        upperTip: [0, 1, 0],
        lowerTip: [0, -1, 0],
        restNock: [0, 0, 0],
        drawHandLocalOffset: [0.05, 0.025, -0.03],
      },
    };
    const content = new THREE.Group();
    content.name = "EquipmentContent";
    root.add(content);
    return { root, content };
  };

  it("fails closed when a fitted bow has no dynamic string authority", () => {
    const { root } = createBow();
    delete root.userData.hyperia.bowString;
    expect(
      validateStreamingEquipmentVisualModel(root, "weapon", {
        itemId: "shortbow",
        avatarId: "steve",
      }),
    ).toEqual({ valid: false, reason: "invalid_dynamic_bow_string" });
  });

  it("keeps certified v1 bows compatible when the optional hand anchor is absent", () => {
    const { root } = createBow();
    delete root.userData.hyperia.bowString.drawHandLocalOffset;
    expect(
      validateStreamingEquipmentVisualModel(root, "weapon", {
        itemId: "shortbow",
        avatarId: "steve",
      }),
    ).toEqual({ valid: true, reason: null });

    const avatarScene = new THREE.Group();
    const rightHand = new THREE.Object3D();
    rightHand.position.set(0.25, 0.1, 0.75);
    avatarScene.add(rightHand);
    avatarScene.updateMatrixWorld(true);
    const controller = createDynamicBowStringController({
      modelRoot: root,
      vrm: {
        scene: avatarScene,
        humanoid: {
          getRawBoneNode: (name: string) =>
            name === "rightHand" ? rightHand : null,
        },
      } as unknown as VRM,
      getState: () => ({ emote: "range" }),
    });
    expect(controller).not.toBeNull();
    controller!.update();
    const positions = controller!.line.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    [0, 1, 0, 0.25, 0.1, 0.75, 0, -1, 0].forEach((value, index) =>
      expect(positions.array[index]).toBeCloseTo(value, 6),
    );
    controller!.dispose();
  });

  it("fails closed when an optional rendered-hand anchor is malformed", () => {
    const { root } = createBow();
    root.userData.hyperia.bowString.drawHandLocalOffset = [0, 0];
    expect(
      validateStreamingEquipmentVisualModel(root, "weapon", {
        itemId: "shortbow",
        avatarId: "steve",
      }),
    ).toEqual({ valid: false, reason: "invalid_dynamic_bow_string" });
  });

  it("keeps a resting string straight and moves its nock to the draw hand", () => {
    const { root, content } = createBow();
    const avatarScene = new THREE.Group();
    const rightHand = new THREE.Object3D();
    rightHand.position.set(0.25, 0.1, 0.75);
    avatarScene.add(rightHand);
    avatarScene.updateMatrixWorld(true);
    let emote = "idle";
    let now = 1_000;
    const transitions: DynamicBowStringTransition[] = [];
    const controller = createDynamicBowStringController({
      modelRoot: root,
      vrm: {
        scene: avatarScene,
        humanoid: {
          getRawBoneNode: (name: string) =>
            name === "rightHand" ? rightHand : null,
        },
      } as unknown as VRM,
      getState: () => ({ emote }),
      now: () => now,
      onTransition: (transition) => transitions.push(transition),
    });
    expect(controller).not.toBeNull();
    const positions = controller!.line.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    expect(Array.from(positions.array)).toEqual([0, 1, 0, 0, 0, 0, 0, -1, 0]);

    emote = "range";
    content.updateMatrixWorld(true);
    controller!.update();
    expect(Array.from(positions.array)).toHaveLength(9);
    [0, 1, 0, 0.3, 0.125, 0.72, 0, -1, 0].forEach((value, index) =>
      expect(positions.array[index]).toBeCloseTo(value, 6),
    );
    expect(controller!.nockedArrow.visible).toBe(true);
    expect(controller!.nockedArrow.parent).toBe(avatarScene);

    expect(
      controller!.scheduleRelease(400, "bronze_arrow", "server-a:launch-1"),
    ).toBe(true);
    expect(transitions).toEqual([
      {
        kind: "scheduled",
        performanceTimeMs: 1_000,
        releaseAtPerformanceTimeMs: 1_400,
        networkEventId: "server-a:launch-1",
      },
    ]);
    now = 1_399;
    // Replicated animation state may briefly leave the ranged pose before the
    // committed server launch deadline. The authoritative draw stays latched.
    emote = "idle";
    controller!.update();
    expect(controller!.nockedArrow.visible).toBe(true);
    now = 1_400;
    controller!.update();
    expect(controller!.nockedArrow.visible).toBe(false);
    expect(transitions[1]).toEqual({
      kind: "released",
      performanceTimeMs: 1_400,
      lastVisibleNockWorldPosition: [0.3, 0.125, 0.72],
      drawHandWorldPosition: [0.3, 0.125, 0.72],
      networkEventId: "server-a:launch-1",
    });
    controller!.update();
    expect(transitions).toHaveLength(2);
    expect(Array.from(positions.array)).toEqual([0, 1, 0, 0, 0, 0, 0, -1, 0]);
    expect(controller!.scheduleRelease(Number.NaN, "bronze_arrow")).toBe(false);
    expect(transitions).toHaveLength(2);

    emote = "idle";
    controller!.update();
    emote = "range";
    now = 1_500;
    controller!.update();
    expect(controller!.nockedArrow.visible).toBe(true);

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    controller!.nockedArrow.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      objectMaterials.forEach((material) => materials.add(material));
    });
    const geometryDisposals = [...geometries].map((geometry) =>
      vi.spyOn(geometry, "dispose"),
    );
    const materialDisposals = [...materials].map((material) =>
      vi.spyOn(material, "dispose"),
    );
    expect(
      controller!.scheduleRelease(400, "bronze_arrow", "server-a:launch-2"),
    ).toBe(true);
    expect(controller!.releaseNow("server-a:launch-wrong")).toBe(false);
    expect(controller!.releaseNow("server-a:launch-2")).toBe(true);
    expect(transitions.at(-1)).toEqual({
      kind: "released",
      performanceTimeMs: 1_500,
      lastVisibleNockWorldPosition: [0.3, 0.125, 0.72],
      drawHandWorldPosition: [0.3, 0.125, 0.72],
      networkEventId: "server-a:launch-2",
    });
    expect(controller!.releaseNow("server-a:launch-2")).toBe(false);
    now = 1_600;
    expect(
      controller!.scheduleRelease(400, "bronze_arrow", "server-a:launch-3"),
    ).toBe(true);
    controller!.dispose();
    expect(transitions.at(-1)).toEqual({
      kind: "cancelled",
      performanceTimeMs: 1_600,
      networkEventId: "server-a:launch-3",
    });
    expect(controller!.line.parent).toBeNull();
    expect(controller!.nockedArrow.parent).toBeNull();
    expect(geometryDisposals.every((spy) => spy.mock.calls.length > 0)).toBe(
      true,
    );
    expect(materialDisposals.every((spy) => spy.mock.calls.length > 0)).toBe(
      true,
    );
  });
});
