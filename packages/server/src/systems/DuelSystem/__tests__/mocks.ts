/**
 * Test Mocks for DuelSystem
 *
 * Provides mock implementations of World and related dependencies
 * for unit testing the duel system components.
 */

import { CollisionMatrix, type ICollisionMatrix } from "@hyperforge/shared";
import { vi } from "vitest";

// ============================================================================
// Mock Types
// ============================================================================

export interface MockPlayer {
  id: string;
  position: { x: number; y: number; z: number };
  name?: string;
  combatLevel?: number;
}

export interface MockWorld {
  entities: {
    players: Map<string, MockPlayer>;
    get: (id: string) => MockPlayer | undefined;
  };
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  getSystem: ReturnType<typeof vi.fn>;
  collision: ICollisionMatrix;
  setPlayerPosition: (
    playerId: string,
    x: number,
    y: number,
    z: number,
  ) => void;
  addPlayer: (player: MockPlayer) => void;
  removePlayer: (playerId: string) => void;
  _emit: ReturnType<typeof vi.fn>;
}

// ============================================================================
// Mock Factory Functions
// ============================================================================

/**
 * Create a mock World for testing
 */
export function createMockWorld(): MockWorld {
  const players = new Map<string, MockPlayer>();
  const emitFn = vi.fn();
  const onFn = vi.fn();
  const offFn = vi.fn();
  const getSystemFn = vi.fn();

  const world: MockWorld = {
    entities: {
      players,
      get: (id: string) => players.get(id),
    },
    emit: emitFn,
    on: onFn,
    off: offFn,
    getSystem: getSystemFn,
    collision: new CollisionMatrix(),
    setPlayerPosition: (playerId: string, x: number, y: number, z: number) => {
      const player = players.get(playerId);
      if (player) {
        player.position = { x, y, z };
      }
    },
    addPlayer: (player: MockPlayer) => {
      players.set(player.id, player);
    },
    removePlayer: (playerId: string) => {
      players.delete(playerId);
    },
    _emit: emitFn,
  };

  return world;
}

/**
 * Create a mock player with default values
 */
export function createMockPlayer(
  id: string,
  overrides: Partial<MockPlayer> = {},
): MockPlayer {
  return {
    id,
    position: { x: 70, y: 0, z: 70 }, // Default in duel arena zone
    name: `Player_${id}`,
    combatLevel: 50,
    ...overrides,
  };
}

/**
 * Create two mock players positioned for dueling
 */
export function createDuelPlayers(): [MockPlayer, MockPlayer] {
  return [
    createMockPlayer("player1", {
      position: { x: 70, y: 0, z: 70 },
      name: "TestPlayer1",
    }),
    createMockPlayer("player2", {
      position: { x: 72, y: 0, z: 70 },
      name: "TestPlayer2",
    }),
  ];
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Advance time for testing timeouts
 */
export function advanceTime(ms: number): void {
  vi.advanceTimersByTime(ms);
}

/**
 * Setup fake timers
 */
export function useFakeTimers(): void {
  vi.useFakeTimers();
}

/**
 * Restore real timers
 */
export function useRealTimers(): void {
  vi.useRealTimers();
}
