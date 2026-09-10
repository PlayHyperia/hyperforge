import { describe, expect, it } from "vitest";
import {
  getCombatArenaBoundsContainingPositions,
  getDuelArenaConfig,
} from "../duel-manifest";

describe("streaming duel arena assignment", () => {
  it("binds both authoritative spawns to one exact combat ring", () => {
    const config = getDuelArenaConfig();
    const positions = [
      [config.baseX + 1, config.baseY, config.baseZ + 1],
      [config.baseX + 2, config.baseY, config.baseZ + 2],
    ] as const;

    expect(getCombatArenaBoundsContainingPositions(positions)).toEqual({
      minX: config.baseX,
      maxX: config.baseX + config.arenaWidth,
      minZ: config.baseZ,
      maxZ: config.baseZ + config.arenaLength,
    });
  });

  it("rejects missing positions or contestants in different rings", () => {
    const config = getDuelArenaConfig();
    const firstRing = [
      config.baseX + 1,
      config.baseY,
      config.baseZ + 1,
    ] as const;
    const secondRing = [
      config.baseX + config.arenaWidth + config.arenaGap + 1,
      config.baseY,
      config.baseZ + 1,
    ] as const;

    expect(
      getCombatArenaBoundsContainingPositions([firstRing, secondRing]),
    ).toBeNull();
    expect(getCombatArenaBoundsContainingPositions([])).toBeNull();
  });
});
