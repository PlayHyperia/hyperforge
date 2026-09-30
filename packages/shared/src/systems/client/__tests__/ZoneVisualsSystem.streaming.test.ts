// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import { ALL_WORLD_AREAS } from "../../../data/world-areas";
import { PlayerEntity } from "../../../entities/player/PlayerEntity";
import THREE from "../../../extras/three/three";
import { resolveZoneNavigationMode } from "../../../runtime/clientViewportMode";
import type { WorldArea } from "../../../types/core/core";
import type { ZoneProperties } from "../../../types/death";
import { ZoneDetectionSystem } from "../../shared/death/ZoneDetectionSystem";
import { Entities } from "../../shared/entities/Entities";
import { Chat } from "../../shared/presentation/Chat";
import {
  shouldRenderZoneMarker,
  ZoneVisualsSystem,
} from "../ZoneVisualsSystem";

const areaIds = [
  "duel_arena",
  "central_haven",
  "haven_pond",
  "future_navigation_marker",
];
let previousUrl: string;
let previousHistoryState: unknown;

beforeEach(() => {
  previousUrl = window.location.href;
  previousHistoryState = window.history.state;
});

afterEach(() => {
  window.history.replaceState(previousHistoryState, "", previousUrl);
});

function visit(path: string): void {
  window.history.replaceState(null, "", path);
}

describe("ZoneVisualsSystem navigation marker policy", () => {
  it.each(["/play", "/", "/play?unrelated=true"])(
    "preserves every ordinary world marker without an opt-in: %s",
    (path) => {
      visit(path);
      expect(resolveZoneNavigationMode(window)).toBe("world-v1");
      expect(resolveZoneNavigationMode()).toBe("world-v1");
      for (const areaId of areaIds) {
        expect(shouldRenderZoneMarker(areaId, window)).toBe(true);
        expect(shouldRenderZoneMarker(areaId)).toBe(true);
      }
    },
  );

  it("moves all ordinary world-marker discovery to the explicit minimap mode", () => {
    visit("/play?zoneNavigation=minimap-v1");
    expect(resolveZoneNavigationMode(window)).toBe("minimap-v1");
    expect(resolveZoneNavigationMode()).toBe("minimap-v1");
    for (const areaId of areaIds) {
      expect(shouldRenderZoneMarker(areaId, window)).toBe(false);
      expect(shouldRenderZoneMarker(areaId)).toBe(false);
    }
  });

  it.each([
    "/stream.html",
    "/?page=stream",
    "/?embedded=true&mode=spectator",
    "/stream.html?zoneNavigation=minimap-v1",
    "/?page=stream&zoneNavigation=minimap-v1",
    "/?embedded=true&mode=spectator&zoneNavigation=minimap-v1",
  ])("suppresses both navigation modes in streaming views: %s", (path) => {
    visit(path);
    expect(resolveZoneNavigationMode(window)).toBe("none");
    for (const areaId of areaIds) {
      expect(shouldRenderZoneMarker(areaId, window)).toBe(false);
      expect(shouldRenderZoneMarker(areaId)).toBe(false);
    }
  });

  it.each([
    "zoneNavigation=",
    "zoneNavigation=world-v1",
    "zoneNavigation=none",
    "zoneNavigation=unknown",
    "zoneNavigation=MINIMAP-V1",
    "zoneNavigation=minimap-v1&zoneNavigation=minimap-v1",
    "zoneNavigation=minimap-v1&zoneNavigation=unknown",
  ])("rejects invalid or duplicate selection even on a stream: %s", (query) => {
    for (const path of ["/play", "/stream.html"]) {
      visit(`${path}?${query}`);
      expect(() => resolveZoneNavigationMode(window)).toThrow(
        "zoneNavigation requires exactly one minimap-v1 value",
      );
      expect(() => shouldRenderZoneMarker("duel_arena", window)).toThrow(
        "zoneNavigation requires exactly one minimap-v1 value",
      );
    }
  });
});

type ZoneVisualInspection = {
  zoneVisuals: Map<
    string,
    { markerSprite: THREE.Sprite | null; borderGroup: THREE.Group | null }
  >;
  emojiTextures: Map<string, THREE.CanvasTexture>;
};

// Actual CPU World, player, zone lookup and Chat path with a real jsdom URL.
// No renderer or canvas implementation is substituted; this is not native
// GPU, minimap-layout or ordinary marker-art qualification.
describe("minimap navigation preserves actual zone safety warnings", () => {
  it("preserves repeated boundary and smallest-overlap lookups", async () => {
    const areas: WorldArea[] = (
      [
        ["test_boundary_pvp", 10001, 10005, 10002, 10008, false, true],
        ["test_boundary_wild", 10002, 10004, 10004, 10006, false, false],
        ["test_boundary_safe", 10000, 10040, 10000, 10020, true, false],
      ] as const
    ).map(([id, minX, maxX, minZ, maxZ, safeZone, pvpEnabled]) => ({
      id,
      name: id,
      description: "Overlapping boundary CPU regression input",
      difficultyLevel: 0,
      bounds: { minX, maxX, minZ, maxZ },
      biomeType: "plains",
      safeZone,
      pvpEnabled,
      npcs: [],
      resources: [],
      mobSpawns: [],
    }));
    const originalAreas = areas.map((area) => ALL_WORLD_AREAS[area.id]);
    const world = new World();
    // An external runner can inspect actual stdout between these markers;
    // no console replacement or fake world/zone implementation is installed.
    const traceStdout = process.env.HYPERIA_ZONE_LOOKUP_STDOUT_PROBE === "1";
    try {
      for (const area of areas) ALL_WORLD_AREAS[area.id] = area;
      const detection = world.register(
        "zone-detection",
        ZoneDetectionSystem,
      ) as ZoneDetectionSystem;
      await detection.init();

      const inside = { x: 10004.9, z: 10003 };
      const outside = { x: 10005.1, z: 10003 };
      // The boundary bisects one cache cell: caching either result would be
      // incorrect for its neighbour, even during repeated stationary checks.
      expect(Math.floor(inside.x / 2)).toBe(Math.floor(outside.x / 2));
      const cases = [
        [inside, "test_boundary_pvp", false, true, true],
        [outside, "test_boundary_safe", true, false, false],
        [{ x: 10001, z: 10003 }, "test_boundary_safe", true, false, false],
        [{ x: 10005, z: 10003 }, "test_boundary_pvp", false, true, true],
        [{ x: 10003, z: 10005 }, "test_boundary_wild", false, false, true],
      ] as const;
      const results: ZoneProperties[] = [];
      if (traceStdout) process.stdout.write("ZONE_LOOKUP_STDOUT_BEGIN\n");
      try {
        for (let repeat = 0; repeat < 4; repeat++) {
          for (const [
            position,
            id,
            isSafe,
            isPvPEnabled,
            isWilderness,
          ] of cases) {
            const result = detection.getZoneProperties(position);
            expect(result).toMatchObject({
              id,
              isSafe,
              isPvPEnabled,
              isWilderness,
            });
            results.push(result);
          }
        }
        const interior = detection.getZoneProperties({ x: 10020, z: 10010 });
        expect(interior.id).toBe("test_boundary_safe");
        expect(detection.getZoneProperties({ x: 10020, z: 10010 })).toBe(
          interior,
        );
      } finally {
        if (traceStdout) process.stdout.write("ZONE_LOOKUP_STDOUT_END\n");
      }
      if (traceStdout) {
        process.stdout.write(
          `ZONE_LOOKUP_RESULTS ${JSON.stringify(results)}\n`,
        );
      }
    } finally {
      world.destroy();
      areas.forEach((area, index) => {
        const original = originalAreas[index];
        if (original) ALL_WORLD_AREAS[area.id] = original;
        else delete ALL_WORLD_AREAS[area.id];
      });
    }
  });

  it("allocates no world markers and retains safe/PvP/wilderness transition messages", async () => {
    visit("/play?zoneNavigation=minimap-v1");
    const areas: WorldArea[] = (
      [
        ["test_navigation_safe", "Navigation Safe", 10000, true, false],
        ["test_navigation_pvp", "Navigation PvP", 10040, false, true],
        ["test_navigation_wild", "Navigation Wild", 10080, false, false],
      ] as const
    ).map(([id, name, minX, safeZone, pvpEnabled]) => ({
      id,
      name,
      description: "Zone navigation CPU regression input",
      difficultyLevel: 0,
      bounds: {
        minX,
        maxX: minX + 20,
        minZ: 10000,
        maxZ: 10020,
      },
      biomeType: "plains",
      safeZone,
      pvpEnabled,
      npcs: [],
      resources: [],
      mobSpawns: [],
    }));
    const originalAreas = areas.map((area) => ALL_WORLD_AREAS[area.id]);
    const world = new World();
    const entities = world.getSystem<Entities>("entities");
    if (!(entities instanceof Entities)) {
      world.destroy();
      throw new Error("Actual World did not register Entities");
    }
    const visuals = new ZoneVisualsSystem(world);
    const inspection = visuals as unknown as ZoneVisualInspection;
    let player: PlayerEntity | undefined;
    try {
      for (const area of areas) ALL_WORLD_AREAS[area.id] = area;
      const detection = world.register(
        "zone-detection",
        ZoneDetectionSystem,
      ) as ZoneDetectionSystem;
      await detection.init();
      player = new PlayerEntity(world, {
        id: "zone-navigation-test-player",
        name: "Zone navigation regression",
        type: "player",
        position: [10010, 0, 10010],
        quaternion: [0, 0, 0, 1],
      });
      entities.set(player.id, player);
      const registeredPlayer = entities.players.get(player.id);
      expect(registeredPlayer).toBe(player);
      if (!registeredPlayer) throw new Error("Player registration failed");
      entities.player = registeredPlayer;
      const chat = world.getSystem<Chat>("chat");
      expect(chat).toBeInstanceOf(Chat);
      if (!chat) throw new Error("Actual World did not register Chat");
      const sceneChildren = [...world.stage.scene.children];
      expect(detection.getZoneProperties(player.position).isSafe).toBe(true);

      visuals.start();
      expect(chat.msgs).toHaveLength(0);
      expect(inspection.zoneVisuals.size).toBe(
        Object.keys(ALL_WORLD_AREAS).length,
      );
      expect(inspection.emojiTextures.size).toBe(0);
      for (const handle of inspection.zoneVisuals.values()) {
        expect(handle.markerSprite).toBeNull();
        expect(handle.borderGroup).toBeNull();
      }
      expect(world.stage.scene.children).toEqual(sceneChildren);

      visuals.update(0.5);
      expect(chat.msgs).toHaveLength(0);
      player.position.set(10050, 0, 10010);
      expect(detection.getZoneProperties(player.position).isPvPEnabled).toBe(
        true,
      );
      visuals.update(0.25);
      expect(chat.msgs).toHaveLength(0);
      visuals.update(0.25);
      expect(chat.msgs.map((message) => message.body)).toEqual([
        "[WARNING] Entering Navigation PvP - PvP enabled! Other players can attack you here.",
      ]);
      visuals.update(0.5);
      expect(chat.msgs).toHaveLength(1);

      player.position.set(10010, 0, 10010);
      visuals.update(0.5);
      player.position.set(10090, 0, 10010);
      const wilderness = detection.getZoneProperties(player.position);
      expect(wilderness.isSafe).toBe(false);
      expect(wilderness.isPvPEnabled).toBe(false);
      visuals.update(0.5);
      visuals.update(0.5);
      expect(chat.msgs).toHaveLength(3);
      player.position.set(10010, 0, 10010);
      visuals.update(0.5);
      expect(chat.msgs.map((message) => message.body)).toEqual([
        "[WARNING] Entering Navigation PvP - PvP enabled! Other players can attack you here.",
        "[SAFE] You have left the PvP zone and entered a safe area.",
        "[CAUTION] Entering Navigation Wild - Dangerous area!",
        "[SAFE] You have returned to a safe area.",
      ]);
      for (const message of chat.msgs) {
        expect(message.fromId).toBe("system");
        expect(message.text).toBe(message.body);
      }
      visuals.destroy();
      expect(inspection.zoneVisuals.size).toBe(0);
      expect(inspection.emojiTextures.size).toBe(0);
      expect(world.stage.scene.children).toEqual(sceneChildren);
    } finally {
      visuals.destroy();
      if (player) {
        entities.player = undefined;
        entities.items.delete(player.id);
        entities.players.delete(player.id);
        player.destroy();
      }
      world.destroy();
      areas.forEach((area, index) => {
        const original = originalAreas[index];
        if (original) ALL_WORLD_AREAS[area.id] = original;
        else delete ALL_WORLD_AREAS[area.id];
      });
    }
  });
});
