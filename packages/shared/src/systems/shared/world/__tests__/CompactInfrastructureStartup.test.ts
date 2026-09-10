import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { BridgeSystem } from "../BridgeSystem";
import { ISLAND_BRIDGES } from "../BridgeDefinition";
import { ISLAND_DOCKS } from "../DockDefinition";
import { ProceduralDocks } from "../ProceduralDocks";
import { TerrainSystem } from "../TerrainSystem";

function createInfrastructure() {
  const world = new World();
  // Reverse dependency order: registration order must not conceal the race.
  const bridges = new BridgeSystem(world);
  const docks = new ProceduralDocks(world);
  const terrain = new TerrainSystem(world);
  world.addSystem("bridges", bridges);
  world.addSystem("docks", docks);
  world.addSystem("terrain", terrain);
  return { world, terrain, bridges, docks };
}

describe("compact infrastructure initialization", () => {
  it("orders actual bridges and docks after terrain regardless of registration order", () => {
    const { world, terrain, bridges, docks } = createInfrastructure();
    expect(bridges.getDependencies().required).toEqual(["terrain"]);
    expect(docks.getDependencies().required).toEqual(["terrain"]);
    expect(world.groupSystemsByDepth([bridges, docks, terrain])).toEqual([
      [terrain],
      [bridges, docks],
    ]);
  });

  it("does not carry retired bridge or dock placements into the compact island", () => {
    expect(DataManager.getWorldTerrainProfile().kind).toBe("compact-candidate");
    // Explicit empty assertions avoid a vacuous all-in-bounds placement check.
    expect(ISLAND_BRIDGES).toEqual([]);
    expect(ISLAND_DOCKS).toEqual([]);
  });

  it("initializes real infrastructure waves with admitted terrain and no obsolete deck overrides", async () => {
    await DataManager.getInstance().initialize();
    const { world, terrain, bridges, docks } = createInfrastructure();
    try {
      const waves = world.groupSystemsByDepth([bridges, docks, terrain]);
      for (const wave of waves) {
        await Promise.all(wave.map((system) => system.init({})));
      }
      const { centerX, centerZ } = terrain.getWorldTerrainProfile().island;
      expect(Number.isFinite(terrain.getHeightAt(centerX, centerZ))).toBe(true);
      expect(bridges.getDeckHeightAtSmooth(877.5, 512.5)).toBeNull();
      expect(docks.getDeckHeightAtSmooth(1075.5, 1172.5)).toBeNull();
      expect(bridges.getDeckHeightAtSmooth(centerX, centerZ)).toBeNull();
      expect(docks.getDeckHeightAtSmooth(centerX, centerZ)).toBeNull();
    } finally {
      docks.destroy();
      bridges.destroy();
      terrain.destroy();
    }
  });
});
