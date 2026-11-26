/**
 * Test Data Factories - World State
 *
 * Provides factory functions for creating complete world state objects.
 * Per project rules: Use real data structures, no mocks.
 *
 * @packageDocumentation
 */

import {
  createLocalPlayer,
  createTestMob,
  createTestNPC,
  type TestPlayer,
  type TestMob,
  type TestNPC,
} from "./entities";
import { createTestInventory, createCoins, type TestItem } from "./items";

/**
 * Player statistics
 */
export interface TestPlayerStats {
  health: { current: number; max: number };
  prayerPoints: { current: number; max: number };
  energy: { current: number; max: number };
  skills: Record<string, { level: number; xp: number; xpToNextLevel: number }>;
}

/**
 * Quest state
 */
export interface TestQuest {
  id: string;
  name: string;
  status: "not_started" | "in_progress" | "completed";
  progress: number;
  objectives: Array<{ id: string; description: string; completed: boolean }>;
}

/**
 * Complete world state for testing
 */
export interface TestWorldState {
  player: TestPlayer;
  stats: TestPlayerStats;
  inventory: TestItem[];
  equipment: Record<string, TestItem | null>;
  bank: TestItem[];
  quests: TestQuest[];
  entities: {
    players: TestPlayer[];
    mobs: TestMob[];
    npcs: TestNPC[];
  };
  world: {
    currentZone: string;
    time: number;
    weather: "clear" | "rain" | "storm";
  };
}

/**
 * Creates default player stats
 */
export function createPlayerStats(
  overrides: Partial<TestPlayerStats> = {},
): TestPlayerStats {
  return {
    health: { current: 100, max: 100 },
    prayerPoints: { current: 10, max: 10 },
    energy: { current: 100, max: 100 },
    skills: {
      attack: { level: 1, xp: 0, xpToNextLevel: 83 },
      strength: { level: 1, xp: 0, xpToNextLevel: 83 },
      defense: { level: 1, xp: 0, xpToNextLevel: 83 },
      hitpoints: { level: 10, xp: 1154, xpToNextLevel: 1358 },
      ranged: { level: 1, xp: 0, xpToNextLevel: 83 },
      magic: { level: 1, xp: 0, xpToNextLevel: 83 },
      prayer: { level: 1, xp: 0, xpToNextLevel: 83 },
      cooking: { level: 1, xp: 0, xpToNextLevel: 83 },
      woodcutting: { level: 1, xp: 0, xpToNextLevel: 83 },
      fishing: { level: 1, xp: 0, xpToNextLevel: 83 },
      firemaking: { level: 1, xp: 0, xpToNextLevel: 83 },
      crafting: { level: 1, xp: 0, xpToNextLevel: 83 },
      smithing: { level: 1, xp: 0, xpToNextLevel: 83 },
      mining: { level: 1, xp: 0, xpToNextLevel: 83 },
    },
    ...overrides,
  };
}

/**
 * Creates a test quest
 */
export function createTestQuest(overrides: Partial<TestQuest> = {}): TestQuest {
  return {
    id: "test_quest",
    name: "Test Quest",
    status: "not_started",
    progress: 0,
    objectives: [
      { id: "obj1", description: "Talk to the quest giver", completed: false },
      { id: "obj2", description: "Defeat 5 goblins", completed: false },
      {
        id: "obj3",
        description: "Return to the quest giver",
        completed: false,
      },
    ],
    ...overrides,
  };
}

/**
 * Creates a complete world state for testing
 */
export function createTestWorldState(
  overrides: Partial<TestWorldState> = {},
): TestWorldState {
  const player = createLocalPlayer();

  return {
    player,
    stats: createPlayerStats(),
    inventory: createTestInventory(),
    equipment: {
      weapon: null,
      shield: null,
      head: null,
      chest: null,
      legs: null,
      feet: null,
      ring: null,
      amulet: null,
      cape: null,
      ammo: null,
    },
    bank: [createCoins(1000)],
    quests: [],
    entities: {
      players: [player],
      mobs: [],
      npcs: [],
    },
    world: {
      currentZone: "starter_region",
      time: 12 * 60 * 60 * 1000, // Noon
      weather: "clear",
    },
    ...overrides,
  };
}

/**
 * Creates a populated world state with multiple entities
 */
export function createPopulatedWorldState(): TestWorldState {
  const player = createLocalPlayer({ position: { x: 0, y: 0, z: 0 } });

  return createTestWorldState({
    player,
    entities: {
      players: [player],
      mobs: [
        createTestMob({ mobType: "goblin", position: { x: 10, y: 0, z: 10 } }),
        createTestMob({ mobType: "goblin", position: { x: 15, y: 0, z: 5 } }),
        createTestMob({ mobType: "chicken", position: { x: -5, y: 0, z: 10 } }),
      ],
      npcs: [
        createTestNPC({ npcType: "banker", position: { x: 20, y: 0, z: 20 } }),
        createTestNPC({
          npcType: "shopkeeper",
          position: { x: 25, y: 0, z: 15 },
        }),
      ],
    },
    quests: [
      createTestQuest({
        id: "tutorial",
        name: "Tutorial Quest",
        status: "in_progress",
        progress: 33,
        objectives: [
          { id: "obj1", description: "Talk to the guide", completed: true },
          { id: "obj2", description: "Explore the town", completed: false },
          { id: "obj3", description: "Complete training", completed: false },
        ],
      }),
    ],
  });
}

/**
 * Creates a world state configured for combat testing
 */
export function createCombatWorldState(): TestWorldState {
  const player = createLocalPlayer({
    position: { x: 0, y: 0, z: 0 },
    health: 100,
    maxHealth: 100,
    level: 10,
  });

  return createTestWorldState({
    player,
    stats: createPlayerStats({
      health: { current: 100, max: 100 },
      skills: {
        attack: { level: 10, xp: 1154, xpToNextLevel: 1358 },
        strength: { level: 10, xp: 1154, xpToNextLevel: 1358 },
        defense: { level: 10, xp: 1154, xpToNextLevel: 1358 },
        hitpoints: { level: 15, xp: 2411, xpToNextLevel: 3000 },
        ranged: { level: 1, xp: 0, xpToNextLevel: 83 },
        magic: { level: 1, xp: 0, xpToNextLevel: 83 },
        prayer: { level: 5, xp: 388, xpToNextLevel: 512 },
        cooking: { level: 1, xp: 0, xpToNextLevel: 83 },
        woodcutting: { level: 1, xp: 0, xpToNextLevel: 83 },
        fishing: { level: 1, xp: 0, xpToNextLevel: 83 },
        firemaking: { level: 1, xp: 0, xpToNextLevel: 83 },
        crafting: { level: 1, xp: 0, xpToNextLevel: 83 },
        smithing: { level: 1, xp: 0, xpToNextLevel: 83 },
        mining: { level: 1, xp: 0, xpToNextLevel: 83 },
      },
    }),
    entities: {
      players: [player],
      mobs: [
        createTestMob({
          mobType: "goblin",
          position: { x: 2, y: 0, z: 0 }, // Close to player
          health: 20,
          maxHealth: 20,
          level: 2,
          aggressive: true,
        }),
      ],
      npcs: [],
    },
  });
}

/**
 * Creates a world state configured for bank testing
 */
export function createBankWorldState(): TestWorldState {
  return createTestWorldState({
    inventory: createTestInventory(),
    bank: [
      createCoins(10000),
      ...createTestInventory(),
      ...createTestInventory(),
    ],
  });
}

/**
 * Creates a minimal world state for quick tests
 */
export function createMinimalWorldState(): TestWorldState {
  const player = createLocalPlayer();

  return {
    player,
    stats: createPlayerStats(),
    inventory: [],
    equipment: {
      weapon: null,
      shield: null,
      head: null,
      chest: null,
      legs: null,
      feet: null,
      ring: null,
      amulet: null,
      cape: null,
      ammo: null,
    },
    bank: [],
    quests: [],
    entities: {
      players: [player],
      mobs: [],
      npcs: [],
    },
    world: {
      currentZone: "spawn",
      time: 0,
      weather: "clear",
    },
  };
}
