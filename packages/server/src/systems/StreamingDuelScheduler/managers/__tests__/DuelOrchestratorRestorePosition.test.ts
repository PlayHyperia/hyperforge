import { beforeAll, describe, expect, it } from "vitest";
import {
  DataManager,
  World,
  getDuelArenaConfig,
  isPositionInsideCombatArena,
} from "@hyperforge/shared";
import { DuelOrchestrator } from "../DuelOrchestrator.js";

beforeAll(async () => {
  await DataManager.getInstance().initialize();
});

/** Real world/orchestrator, without starting a server, database or combat loop. */
function createOrchestrator() {
  const unexpectedMutation = (): never => {
    throw new Error("Position admission must not mutate the duel cycle");
  };
  return new DuelOrchestrator(
    new World(),
    () => null,
    unexpectedMutation,
    () => new Map(),
    unexpectedMutation,
    unexpectedMutation,
    () => [],
    () => [],
  );
}

describe("compact duel restoration position admission", () => {
  it("rehomes the hydrated missing-entity origin and every retired-world boundary escape", () => {
    const orchestrator = createOrchestrator();
    const agentId = "restore-origin-fixture";
    const fallback = orchestrator.getFallbackLobbyPosition(agentId);
    const { bounds } = DataManager.getWorldTerrainProfile();
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    const positions: Array<[number, number, number] | null> = [
      null,
      [0, 0, 0],
      [bounds.minX - 0.001, 20, cz],
      [bounds.maxX + 0.001, 20, cz],
      [cx, 20, bounds.minZ - 0.001],
      [cx, 20, bounds.maxZ + 0.001],
      [NaN, 20, cz],
      [cx, 20, Infinity],
    ];
    for (const position of positions) {
      expect(orchestrator.sanitizeRestorePosition(position, agentId)).toEqual(
        fallback,
      );
    }
  });

  it("preserves valid preparation positions and the existing vertical repair thresholds", () => {
    const orchestrator = createOrchestrator();
    const agentId = "restore-preparation-fixture";
    const fallback = orchestrator.getFallbackLobbyPosition(agentId);
    const lobby = getDuelArenaConfig().lobbySpawnPoint;
    expect(isPositionInsideCombatArena(lobby.x, lobby.z)).toBe(false);
    for (const delta of [-15, 0, 25, 80]) {
      const input: [number, number, number] = [
        lobby.x,
        fallback[1] + delta,
        lobby.z,
      ];
      expect(orchestrator.sanitizeRestorePosition(input, agentId)).toEqual(
        input,
      );
    }
    for (const y of [
      NaN,
      Infinity,
      fallback[1] - 15.001,
      fallback[1] + 80.001,
    ]) {
      expect(
        orchestrator.sanitizeRestorePosition([lobby.x, y, lobby.z], agentId),
      ).toEqual([lobby.x, fallback[1], lobby.z]);
    }
  });

  it("still excludes combat rings and keeps deterministic per-agent fallback positions in compact bounds", () => {
    const orchestrator = createOrchestrator();
    const arena = getDuelArenaConfig();
    const { bounds } = DataManager.getWorldTerrainProfile();
    for (let i = 0; i < 64; i++) {
      const agentId = `restoration-agent-${i}`;
      const fallback = orchestrator.getFallbackLobbyPosition(agentId);
      expect(fallback).toEqual(orchestrator.getFallbackLobbyPosition(agentId));
      expect(fallback[0]).toBeGreaterThanOrEqual(bounds.minX);
      expect(fallback[0]).toBeLessThanOrEqual(bounds.maxX);
      expect(fallback[2]).toBeGreaterThanOrEqual(bounds.minZ);
      expect(fallback[2]).toBeLessThanOrEqual(bounds.maxZ);
      expect(isPositionInsideCombatArena(fallback[0], fallback[2])).toBe(false);
      expect(
        orchestrator.sanitizeRestorePosition(
          [
            arena.baseX + arena.arenaWidth / 2,
            30,
            arena.baseZ + arena.arenaLength / 2,
          ],
          agentId,
        ),
      ).toEqual(fallback);
    }
  });
});
