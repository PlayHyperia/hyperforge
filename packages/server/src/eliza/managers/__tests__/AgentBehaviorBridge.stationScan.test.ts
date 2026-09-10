import { describe, expect, it } from "vitest";

import { AgentBehaviorBridge } from "../AgentBehaviorBridge";
import type {
  SharedTickData,
  WorkerStationData,
} from "../../worker/workerTypes";

type StationScanInternals = {
  updateWorldScanCaches(): void;
  stationPositionsCache: WorkerStationData[];
  worldResourcesCache: SharedTickData["worldResources"];
  worldMobsCache: SharedTickData["worldMobs"];
};

function worldEntity(params: {
  id: string;
  name: string;
  dataType: string;
  entityType?: string;
  position: [number, number, number];
  interactionDistance?: number;
  footprint?: { width: number; depth: number };
  npcType?: string;
  resourceId?: string;
  resourceType?: string;
  depleted?: boolean;
  configResourceId?: string;
  configResourceType?: string;
  configDepleted?: boolean;
  mobType?: string;
  configMobType?: string;
  propertyMobType?: string;
  health?: number;
  dead?: boolean;
}) {
  return {
    id: params.id,
    ...(params.entityType ? { entityType: params.entityType } : {}),
    position: params.position,
    ...(params.footprint
      ? { getInteractionFootprint: () => ({ ...params.footprint! }) }
      : {}),
    config: {
      ...(params.interactionDistance === undefined
        ? {}
        : { interactionDistance: params.interactionDistance }),
      ...(params.npcType ? { npcType: params.npcType } : {}),
      ...(params.configMobType ? { mobType: params.configMobType } : {}),
      ...(params.configResourceId
        ? { resourceId: params.configResourceId }
        : {}),
      ...(params.configResourceType
        ? { resourceType: params.configResourceType }
        : {}),
      ...(params.configDepleted === undefined
        ? {}
        : { depleted: params.configDepleted }),
    },
    ...(params.propertyMobType
      ? { getProperty: () => params.propertyMobType }
      : {}),
    data: {
      id: params.id,
      name: params.name,
      type: params.dataType,
      position: params.position,
      ...(params.resourceId ? { resourceId: params.resourceId } : {}),
      ...(params.resourceType ? { resourceType: params.resourceType } : {}),
      ...(params.depleted === undefined ? {} : { depleted: params.depleted }),
      ...(params.mobType ? { mobType: params.mobType } : {}),
      ...(params.health === undefined ? {} : { health: params.health }),
      ...(params.dead === undefined ? {} : { dead: params.dead }),
    },
  };
}

describe("AgentBehaviorBridge workstation scan", () => {
  it("publishes exact loaded station identities and rejects display-name lookalikes", () => {
    const entities = new Map<string, ReturnType<typeof worldEntity>>([
      [
        "furnace-live",
        worldEntity({
          id: "furnace-live",
          name: "Town Furnace",
          dataType: "object",
          entityType: "furnace",
          position: [10, 0, 10],
          interactionDistance: 2,
          footprint: { width: 2, depth: 1 },
        }),
      ],
      [
        "anvil-live",
        worldEntity({
          id: "anvil-live",
          name: "Town Anvil",
          dataType: "object",
          entityType: "anvil",
          position: [12, 0, 10],
          interactionDistance: 2,
        }),
      ],
      [
        "air-altar-live",
        worldEntity({
          id: "air-altar-live",
          name: "Air Altar",
          dataType: "object",
          entityType: "runecrafting_altar",
          position: [14, 0, 10],
          interactionDistance: 2,
        }),
      ],
      [
        "Bank-Live-CaseSensitive",
        worldEntity({
          id: "Bank-Live-CaseSensitive",
          name: "Town Bank",
          dataType: "bank",
          position: [16, 0, 10],
          interactionDistance: 9,
        }),
      ],
      [
        "tanner-live",
        worldEntity({
          id: "tanner-live",
          name: "Tanner",
          dataType: "npc",
          position: [18, 0, 10],
          interactionDistance: 4,
          npcType: "tanner",
        }),
      ],
      [
        "decorative-anvil",
        worldEntity({
          id: "decorative-anvil",
          name: "Anvil Display",
          dataType: "decoration",
          position: [1, 0, 1],
          interactionDistance: 2,
        }),
      ],
      [
        "prayer-altar",
        worldEntity({
          id: "prayer-altar",
          name: "Air Altar Decoration",
          dataType: "object",
          entityType: "altar",
          position: [2, 0, 2],
          interactionDistance: 2,
        }),
      ],
    ]);
    const world = { entities: { items: entities } };
    const bridge = new AgentBehaviorBridge(
      world as never,
      () => undefined,
      () => [],
    );
    const internals = bridge as unknown as StationScanInternals;

    internals.updateWorldScanCaches();

    expect(internals.stationPositionsCache).toEqual([
      {
        entityId: "furnace-live",
        position: [10, 0, 10],
        name: "town furnace furnace-live",
        stationType: "furnace",
        interactionRange: 2,
        footprintWidth: 2,
        footprintDepth: 1,
      },
      {
        entityId: "anvil-live",
        position: [12, 0, 10],
        name: "town anvil anvil-live",
        stationType: "anvil",
        interactionRange: 2,
        footprintWidth: 1,
        footprintDepth: 1,
      },
      {
        entityId: "air-altar-live",
        position: [14, 0, 10],
        name: "air altar air-altar-live",
        stationType: "runecrafting",
        interactionRange: 2,
        footprintWidth: 1,
        footprintDepth: 1,
      },
      {
        entityId: "Bank-Live-CaseSensitive",
        position: [16, 0, 10],
        name: "town bank bank-live-casesensitive",
        stationType: "bank",
        interactionRange: 2,
        footprintWidth: 1,
        footprintDepth: 1,
      },
      {
        entityId: "tanner-live",
        position: [18, 0, 10],
        name: "tanner tanner-live",
        stationType: "tanner",
        interactionRange: 4,
        footprintWidth: 1,
        footprintDepth: 1,
      },
    ]);
  });

  it("preserves exact manifest resource identities and excludes unidentified lookalikes", () => {
    const entities = new Map<string, ReturnType<typeof worldEntity>>([
      [
        "exact-ore-node",
        worldEntity({
          id: "exact-ore-node",
          name: "Misleading Tree",
          dataType: "resource",
          position: [20, 0, 30],
          resourceId: "ore_copper",
          resourceType: "mining_rock",
        }),
      ],
      [
        "depleted-tree-node",
        worldEntity({
          id: "depleted-tree-node",
          name: "Copper Rock",
          dataType: "resource",
          position: [22, 0, 30],
          resourceId: "tree_general",
          resourceType: "tree",
          depleted: true,
        }),
      ],
      [
        "runtime-fishing-node",
        worldEntity({
          id: "runtime-fishing-node",
          name: "Net Fishing Spot",
          dataType: "resource",
          position: [-8.5, 28.2, -16],
          configResourceId: "fishing_spot_net",
          configResourceType: "fishing_spot",
          configDepleted: false,
        }),
      ],
      [
        "unidentified-resource",
        worldEntity({
          id: "unidentified-resource",
          name: "Copper Rock",
          dataType: "resource",
          position: [1, 0, 1],
          resourceType: "mining_rock",
        }),
      ],
    ]);
    const bridge = new AgentBehaviorBridge(
      { entities: { items: entities } } as never,
      () => undefined,
      () => [],
    );
    const internals = bridge as unknown as StationScanInternals;

    internals.updateWorldScanCaches();

    expect(internals.worldResourcesCache).toEqual([
      {
        entityId: "exact-ore-node",
        position: [20, 0, 30],
        name: "misleading tree",
        resourceId: "ore_copper",
        resourceType: "mining_rock",
        depleted: false,
      },
      {
        entityId: "depleted-tree-node",
        position: [22, 0, 30],
        name: "copper rock",
        resourceId: "tree_general",
        resourceType: "tree",
        depleted: true,
      },
      {
        entityId: "runtime-fishing-node",
        position: [-8.5, 28.2, -16],
        name: "net fishing spot",
        resourceId: "fishing_spot_net",
        resourceType: "fishing_spot",
        depleted: false,
      },
    ]);
  });

  it("publishes only exact live mob identities for distant acquisition", () => {
    const entities = new Map<string, ReturnType<typeof worldEntity>>([
      [
        "exact-cow",
        worldEntity({
          id: "exact-cow",
          name: "Misleading goblin",
          dataType: "mob",
          entityType: "mob",
          mobType: "cow",
          health: 8,
          position: [30, 0, 40],
        }),
      ],
      [
        "dead-cow",
        worldEntity({
          id: "dead-cow",
          name: "Cow",
          dataType: "mob",
          entityType: "mob",
          mobType: "cow",
          health: 0,
          dead: true,
          position: [31, 0, 40],
        }),
      ],
      [
        "runtime-goblin",
        worldEntity({
          id: "runtime-goblin",
          name: "Misleading cow",
          dataType: "mob",
          entityType: "mob",
          configMobType: "goblin",
          health: 5,
          position: [20, 0, 25],
        }),
      ],
      [
        "property-bandit",
        worldEntity({
          id: "property-bandit",
          name: "Misleading guard",
          dataType: "mob",
          entityType: "mob",
          propertyMobType: "bandit",
          health: 7,
          position: [25, 0, 30],
        }),
      ],
      [
        "name-only-cow",
        worldEntity({
          id: "name-only-cow",
          name: "Cow",
          dataType: "mob",
          entityType: "mob",
          health: 8,
          position: [1, 0, 1],
        }),
      ],
    ]);
    const bridge = new AgentBehaviorBridge(
      { entities: { items: entities } } as never,
      () => undefined,
      () => [],
    );
    const internals = bridge as unknown as StationScanInternals;

    internals.updateWorldScanCaches();

    expect(internals.worldMobsCache).toEqual([
      { position: [25, 0, 30], mobType: "bandit" },
      { position: [30, 0, 40], mobType: "cow" },
      { position: [20, 0, 25], mobType: "goblin" },
    ]);
  });
});
