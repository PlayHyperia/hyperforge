#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TileMovementManager } from "../src/systems/ServerNetwork/tile-movement.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(SERVER_DIR, "../..");
const FRAMEWORK_PATH = path.join(
  REPO_ROOT,
  "packages/shared/build/framework.js",
);
const MANIFEST_SOURCE = path.join(SERVER_DIR, "world/assets/manifests");
const DEFAULT_REPORT_PATH = path.join(
  REPO_ROOT,
  "artifacts/duel-launch-processing-quiescence/live-world-report.json",
);
const REPORT_PATH = path.resolve(
  process.env.PROCESSING_QUIESCENCE_REPORT ?? DEFAULT_REPORT_PATH,
);

async function writePrivateReport(report) {
  await mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  // `mode` applies only when a file is created. Tighten a deliberately reused
  // diagnostic path as well so private bank/custody evidence is never left
  // group- or world-readable.
  await chmod(REPORT_PATH, 0o600);
}
const DURABLE_DATABASE_URL =
  process.env.PROCESSING_LIVE_WORLD_DATABASE_URL?.trim() || null;
const PREPARATION_ONLY =
  process.env.PROCESSING_LIVE_WORLD_PREPARATION_ONLY === "true";
const HOLD_AFTER_PREPARATION =
  process.env.PROCESSING_LIVE_WORLD_HOLD_AFTER_PREPARATION === "true";
const PREPARATION_FORGING_QUEST =
  process.env.PROCESSING_LIVE_WORLD_FORGING_QUEST === "true";
if (
  process.env.PROCESSING_LIVE_WORLD_FORGING_QUEST !== undefined &&
  !["true", "false"].includes(
    process.env.PROCESSING_LIVE_WORLD_FORGING_QUEST.trim().toLowerCase(),
  )
) {
  throw new Error("PROCESSING_LIVE_WORLD_FORGING_QUEST must be true or false");
}
const OPTIONAL_CLOUD_MANIFESTS = new Set([
  "ammunition.json",
  "duel-arenas.json",
  "duel-presentation-assets.json",
  "music.json",
  "quests.json",
  "vegetation.json",
]);
const SYSTEM_NAMES = [
  "processing",
  "smelting",
  "smithing",
  "crafting",
  "fletching",
  "runecrafting",
  "tanning",
];
const SKILL_NAMES = [
  "cooking",
  "firemaking",
  "smithing",
  "crafting",
  "fletching",
  "runecrafting",
];
const PLAYER_ID = "launch-matrix-agent";
const PREPARATION_AGENT_ID =
  process.env.PROCESSING_LIVE_WORLD_PREPARATION_AGENT_ID?.trim() ||
  "launch-preparation-agent";
const PREPARATION_ACCOUNT_ID =
  process.env.PROCESSING_LIVE_WORLD_PREPARATION_ACCOUNT_ID?.trim() ||
  "live-world-processing-account";
const PREPARATION_AGENT_NAME =
  process.env.PROCESSING_LIVE_WORLD_PREPARATION_AGENT_NAME?.trim() ||
  "Launch Preparation Agent";
const PREPARATION_READY_SLOT_INPUT =
  process.env.PROCESSING_LIVE_WORLD_PREPARATION_READY_SLOT?.trim() ?? "";
const PREPARATION_READY_SLOT =
  PREPARATION_READY_SLOT_INPUT === ""
    ? null
    : Number.parseInt(PREPARATION_READY_SLOT_INPUT, 10);
if (
  PREPARATION_READY_SLOT !== null &&
  PREPARATION_READY_SLOT !== 0 &&
  PREPARATION_READY_SLOT !== 1
) {
  throw new Error(
    "PROCESSING_LIVE_WORLD_PREPARATION_READY_SLOT must be 0, 1, or unset",
  );
}
const PREPARATION_TOOL_ID = "small_fishing_net";
const PREPARATION_RAW_FOOD_ID = "raw_shrimp";
const PREPARATION_FOOD_ID = "shrimp";
const PREPARATION_BURNT_FOOD_ID = "burnt_shrimp";
const PREPARATION_FORGING_QUEST_ID = "torvins_tools";
const PREPARATION_FORGED_WEAPON_ID = "bronze_shortsword";
const PREPARATION_FORGING_PRECEDING_QUESTS = [
  "goblin_slayer",
  "lumberjacks_first_lesson",
  "fresh_catch",
  "rune_mysteries",
];
const PREPARATION_PROGRESS_STARTED_AT = Date.now();
const POPULATION_SIZE = 25;
const POPULATION_PREFIX = "launch-station-agent-";
const POPULATION_MAX_TICKS = 80;
const POPULATION_TICK_MS = 600;
const MIN_POPULATION_WORLD_TICK_SAMPLES = 20;
const WORLD_TICK_WARNING_THRESHOLD_MS = 50;
const OBSERVED_EVENT_TYPES = new Set([
  "processing:interaction:presentation",
  "processing:request:progress",
  "processing:request:rejected",
  "player:set_emote",
  "xp:drop_broadcast",
  "resource:gathering:started",
  "resource:gathering:completed",
  "gathering:tool:show",
  "gathering:tool:hide",
  "fishing:interaction:presentation",
  "cooking:completed",
  "fire:created",
  "smelting:success",
  "smelting:complete",
  "smithing:complete",
  "crafting:complete",
  "fletching:complete",
  "runecrafting:complete",
  "tanning:complete",
]);

const CASES = [
  {
    family: "cooking",
    system: "processing",
    inputs: [
      ["raw_shrimp", 1],
      ["logs", 1],
      ["tinderbox", 1],
    ],
    completionEvent: "cooking:completed",
    expectedXpEvents: 1,
  },
  {
    family: "firemaking",
    system: "processing",
    inputs: [
      ["logs", 1],
      ["tinderbox", 1],
    ],
    completionEvent: "fire:created",
    expectedXpEvents: 1,
  },
  {
    family: "smelting",
    system: "smelting",
    inputs: [
      ["copper_ore", 1],
      ["tin_ore", 1],
    ],
    completionEvent: "smelting:success",
    expectedXpEvents: 1,
  },
  {
    family: "smithing",
    system: "smithing",
    inputs: [
      ["bronze_bar", 1],
      ["hammer", 1],
    ],
    completionEvent: "smithing:complete",
    expectedXpEvents: 1,
  },
  {
    family: "crafting",
    system: "crafting",
    inputs: [
      ["leather", 1],
      ["needle", 1],
      ["thread", 1],
    ],
    completionEvent: "crafting:complete",
    expectedXpEvents: 1,
  },
  {
    family: "fletching",
    system: "fletching",
    inputs: [
      ["logs", 1],
      ["knife", 1],
    ],
    completionEvent: "fletching:complete",
    expectedXpEvents: 1,
  },
  {
    family: "runecrafting",
    system: "runecrafting",
    inputs: [["rune_essence", 2]],
    completionEvent: "runecrafting:complete",
    expectedXpEvents: 1,
  },
  {
    family: "tanning",
    system: "tanning",
    inputs: [["cowhide", 2]],
    completionEvent: "tanning:complete",
    expectedXpEvents: 0,
  },
];

function assert(condition, message, details) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  );
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function emitPreparationProgress(stage) {
  if (!PREPARATION_ONLY) return;
  console.log(
    JSON.stringify({
      event: "ordinary_preparation_progress",
      preparationAgentId: PREPARATION_AGENT_ID,
      stage,
      elapsedMs: Date.now() - PREPARATION_PROGRESS_STARTED_AT,
    }),
  );
}

async function copyManifestFile(sourcePath, destinationPath) {
  const maximumAttempts = 5;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const bytes = await readFile(sourcePath);
      await writeFile(destinationPath, bytes);
      return;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : null;
      if (code !== "ECANCELED" || attempt === maximumAttempts) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 50 * 2 ** (attempt - 1)),
      );
    }
  }
}

async function copyManifestTree(source, destination, relative = "") {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relativePath = path.join(relative, entry.name);
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (
      !relative &&
      entry.isFile() &&
      OPTIONAL_CLOUD_MANIFESTS.has(entry.name) &&
      !(PREPARATION_FORGING_QUEST && entry.name === "quests.json")
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      await copyManifestTree(sourcePath, destinationPath, relativePath);
    } else if (entry.isFile()) {
      await copyManifestFile(sourcePath, destinationPath);
    }
  }
}

async function digestTree(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolutePath);
      if (entry.isFile()) files.push(absolutePath);
    }
  }
  await walk(root);
  const records = [];
  for (const absolutePath of files) {
    const bytes = await readFile(absolutePath);
    records.push({
      path: path.relative(root, absolutePath).split(path.sep).join("/"),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  return { files: records, sha256: sha256(stableJson(records)) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function normalizeInventory(inventorySystem, playerId) {
  return inventorySystem
    .getInventoryData(playerId)
    .items.map(({ itemId, quantity, slot }) => ({ itemId, quantity, slot }))
    .sort((left, right) => left.slot - right.slot);
}

function normalizeEquipment(equipmentSystem, playerId) {
  const equipment = equipmentSystem.getEquipmentData(playerId);
  return Object.fromEntries(
    Object.entries(equipment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([slot, item]) => [slot, item?.id ?? null]),
  );
}

function normalizeBank(bankingSystem, playerId) {
  const bank = bankingSystem.getBankData(playerId, "bank_town_0");
  return {
    maxSlots: bank?.maxSlots ?? null,
    items: (bank?.items ?? [])
      .map(({ itemId, quantity, slot }) => ({ itemId, quantity, slot }))
      .sort((left, right) => left.slot - right.slot),
  };
}

async function seedDurablePlayers(pool, players) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO users (id, name, roles, "createdAt")
       VALUES ($1, $2, 'test', $3)
       ON CONFLICT (id) DO NOTHING`,
      [
        PREPARATION_ACCOUNT_ID,
        PREPARATION_AGENT_NAME,
        new Date().toISOString(),
      ],
    );
    for (const player of players) {
      await client.query(
        `INSERT INTO characters
           (id, "accountId", name, "cookingLevel", "cookingXp", "isAgent")
         VALUES ($1, $2, $3, $4, 0, 1)
         ON CONFLICT (id) DO NOTHING`,
        [
          player.playerId,
          PREPARATION_ACCOUNT_ID,
          player.name,
          player.cookingLevel ?? 1,
        ],
      );
      if (player.rawShrimp === true) {
        await client.query(
          `INSERT INTO inventory
             ("playerId", "itemId", quantity, "slotIndex", metadata)
           VALUES ($1, 'raw_shrimp', 1, 0, NULL)`,
          [player.playerId],
        );
      }
      for (const [index, item] of (player.bankItems ?? []).entries()) {
        await client.query(
          `INSERT INTO bank_storage
             ("playerId", "itemId", quantity, slot, "tabIndex")
           VALUES ($1, $2, $3, $4, 0)`,
          [player.playerId, item.itemId, item.quantity, index],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function currentPresentation(events) {
  const match = events
    .filter(
      (event) =>
        event.type === "processing:interaction:presentation" &&
        event.data?.playerId === PLAYER_ID,
    )
    .at(-1)?.data;
  if (!match) return null;
  return {
    phase: match.phase ?? null,
    skill: match.skill ?? null,
    targetEntityId: match.targetEntityId ?? null,
    targetPosition: match.targetPosition ?? null,
  };
}

function currentEmote(events, player) {
  const event = events
    .filter(
      (entry) =>
        entry.type === "player:set_emote" && entry.data?.playerId === PLAYER_ID,
    )
    .at(-1)?.data;
  return {
    entity: player.data?.emote ?? null,
    event: event?.emote ?? null,
  };
}

function snapshotState(context) {
  const { banking, coinPouch, equipment, events, inventory, player, skills } =
    context;
  const allSkills = skills.getSkills(PLAYER_ID) ?? {};
  return stable({
    bank: normalizeBank(banking, PLAYER_ID),
    coins: coinPouch.getCoins(PLAYER_ID),
    equipment: normalizeEquipment(equipment, PLAYER_ID),
    inventory: normalizeInventory(inventory, PLAYER_ID),
    pose: currentEmote(events, player),
    presentation: currentPresentation(events),
    selectedSpell: {
      entity: player.data?.selectedSpell ?? null,
      player: player.selectedSpell ?? null,
    },
    xp: Object.fromEntries(
      SKILL_NAMES.map((skill) => [
        skill,
        {
          level: allSkills[skill]?.level ?? null,
          xp: allSkills[skill]?.xp ?? null,
        },
      ]),
    ),
  });
}

function snapshotRewardState(snapshot) {
  return stable({
    bank: snapshot.bank,
    coins: snapshot.coins,
    equipment: snapshot.equipment,
    inventory: snapshot.inventory,
    selectedSpell: snapshot.selectedSpell,
    xp: snapshot.xp,
  });
}

function setInventory(context, entries) {
  const live = context.inventory.getInventory(PLAYER_ID);
  assert(live, "authoritative inventory was not initialized");
  live.items.length = 0;
  let slot = 0;
  for (const [itemId, quantity] of entries) {
    const item = context.getItem(itemId);
    assert(item, `missing item definition: ${itemId}`);
    if (item.stackable) {
      live.items.push({
        id: `matrix-${itemId}-${slot}`,
        itemId,
        quantity,
        slot,
        item,
        metadata: null,
      });
      slot += 1;
      continue;
    }
    for (let count = 0; count < quantity; count += 1) {
      live.items.push({
        id: `matrix-${itemId}-${slot}`,
        itemId,
        quantity: 1,
        slot,
        item,
        metadata: null,
      });
      slot += 1;
    }
  }
  context.world.emit("inventory:updated", {
    playerId: PLAYER_ID,
    items: live.items.map(({ itemId, quantity, slot: itemSlot }) => ({
      itemId,
      quantity,
      slot: itemSlot,
    })),
  });
}

function debitItem(items, itemId, quantity) {
  let remaining = quantity;
  for (let index = 0; index < items.length && remaining > 0;) {
    const entry = items[index];
    if (entry.itemId !== itemId) {
      index += 1;
      continue;
    }
    const debit = Math.min(entry.quantity, remaining);
    entry.quantity -= debit;
    remaining -= debit;
    if (entry.quantity === 0) items.splice(index, 1);
    else index += 1;
  }
  assert(remaining === 0, `controlled receipt could not debit ${itemId}`, {
    itemId,
    quantity,
    remaining,
  });
}

function applyCommittedMutation(context, call) {
  const playerId = call.playerId;
  const live = context.inventory.getInventory(playerId);
  assert(live, "authoritative inventory disappeared before receipt commit");
  for (const input of call.input.inputs) {
    debitItem(live.items, input.itemId, input.quantity);
  }
  for (const output of call.input.outputs) {
    const item = context.getItem(output.itemId);
    assert(item, `missing output item definition: ${output.itemId}`);
    const existing = item.stackable
      ? live.items.find((entry) => entry.itemId === output.itemId)
      : null;
    if (existing) {
      existing.quantity += output.quantity;
      continue;
    }
    if (item.stackable) {
      live.items.push({
        id: `matrix-output-${output.itemId}`,
        itemId: output.itemId,
        quantity: output.quantity,
        slot: live.items.length,
        item,
        metadata: null,
      });
      continue;
    }
    for (let count = 0; count < output.quantity; count += 1) {
      live.items.push({
        id: `matrix-output-${output.itemId}-${count}`,
        itemId: output.itemId,
        quantity: 1,
        slot: live.items.length,
        item,
        metadata: null,
      });
    }
  }
  live.items.forEach((entry, index) => {
    entry.slot = index;
  });
  if (call.input.coinCost) {
    const nextCoins =
      context.coinPouch.getCoins(playerId) - call.input.coinCost;
    assert(nextCoins >= 0, "controlled receipt would overdraw money pouch");
    assert(
      context.coinPouch.applyCommittedBalance(playerId, nextCoins),
      "money-pouch convergence rejected committed receipt",
    );
  }
}

function receiptFor(context, call) {
  const playerId = call.playerId;
  const skill = call.input.skill;
  const currentSkill = context.skills.getSkillData(playerId, skill);
  const currentXp = currentSkill?.xp ?? 0;
  const awardedXp = call.input.xpAmount;
  const consumableStates = (call.input.consumables ?? []).map((consumable) => ({
    itemId: consumable.itemId,
    usesPerItem: consumable.usesPerItem,
    remainingUses: Math.max(0, consumable.usesPerItem - 1),
    consumedQuantity: consumable.usesPerItem === 1 ? 1 : 0,
  }));
  const worldEffect = call.input.worldEffect
    ? {
        kind: "fire",
        fireId: call.input.worldEffect.fireId,
        position: call.input.worldEffect.position,
        tile: call.input.worldEffect.tile,
        createdAt: Date.now(),
        expiresAt: Date.now() + call.input.worldEffect.durationMs,
      }
    : undefined;
  const currentCoins = call.input.coinCost
    ? context.coinPouch.getCoins(playerId)
    : undefined;
  return {
    ok: true,
    committed: true,
    liveInventoryApplied: true,
    playerId: call.playerId,
    operationId: call.operationId,
    replayed: false,
    skill,
    xpAmount: awardedXp,
    inputs: call.input.inputs,
    requiredItems: call.input.requiredItems ?? [],
    consumables: call.input.consumables ?? [],
    consumableStates,
    outputs: call.input.outputs.map((output) => ({
      ...output,
      stackable: context.getItem(output.itemId)?.stackable === true,
    })),
    ...(call.input.coinCost
      ? { coinCost: call.input.coinCost, currentCoins }
      : {}),
    ...(worldEffect ? { worldEffect } : {}),
    awardedXp,
    operationCommittedXp: currentXp + awardedXp,
    currentXp: currentXp + awardedXp,
    currentLevel: context.skills.getLevelForXP(currentXp + awardedXp),
  };
}

function installStations(world, position) {
  const at = (x, z) => ({
    x: position.x + x,
    y: position.y,
    z: position.z + z,
  });
  const destroy = () => {};
  const stations = [
    [
      "matrix-range",
      {
        id: "matrix-range",
        entityType: "range",
        position: at(1, 0),
        canInteract: () => true,
        destroy,
      },
    ],
    [
      "matrix-furnace",
      {
        id: "matrix-furnace",
        entityType: "furnace",
        position: at(1, 0),
        canInteract: () => true,
        destroy,
      },
    ],
    [
      "matrix-anvil",
      {
        id: "matrix-anvil",
        entityType: "anvil",
        position: at(1, 0),
        canInteract: () => true,
        destroy,
      },
    ],
    [
      "matrix-air-altar",
      {
        id: "matrix-air-altar",
        entityType: "runecrafting_altar",
        runeType: "air",
        position: at(1, 0),
        isPlayerInRange: () => true,
        destroy,
      },
    ],
    [
      "matrix-tanner",
      {
        id: "matrix-tanner",
        position: at(1, 1),
        config: {
          npcType: "tanner",
          npcId: "tanner",
          interactionDistance: 3,
        },
        destroy,
      },
    ],
  ];
  for (const [id, station] of stations) world.entities.items.set(id, station);
}

function startCase(context, definition, requestId) {
  const { EventType, player, world } = context;
  const system = world.getSystem(definition.system);
  const tick = world.currentTick;
  switch (definition.family) {
    case "cooking": {
      const fishSlot = context.inventory
        .getInventory(PLAYER_ID)
        .items.find((item) => item.itemId === "raw_shrimp").slot;
      world.emit(EventType.PROCESSING_COOKING_REQUEST, {
        playerId: PLAYER_ID,
        fishSlot,
        rangeId: "matrix-range",
        sourceType: "range",
        requestId,
      });
      break;
    }
    case "firemaking": {
      const items = context.inventory.getInventory(PLAYER_ID).items;
      const logsSlot = items.find((item) => item.itemId === "logs").slot;
      const tinderboxSlot = items.find(
        (item) => item.itemId === "tinderbox",
      ).slot;
      world.emit(EventType.PROCESSING_FIREMAKING_REQUEST, {
        playerId: PLAYER_ID,
        logsId: "logs",
        logsSlot,
        tinderboxSlot,
        requestId,
      });
      break;
    }
    case "smelting":
      world.emit(EventType.SMELTING_INTERACT, {
        playerId: PLAYER_ID,
        furnaceId: "matrix-furnace",
      });
      world.emit(EventType.PROCESSING_SMELTING_REQUEST, {
        playerId: PLAYER_ID,
        barItemId: "bronze_bar",
        furnaceId: "matrix-furnace",
        quantity: 1,
        requestId,
      });
      world.currentTick = tick + 4;
      system.update(0.6);
      break;
    case "smithing":
      world.emit(EventType.SMITHING_INTERACT, {
        playerId: PLAYER_ID,
        anvilId: "matrix-anvil",
      });
      world.emit(EventType.PROCESSING_SMITHING_REQUEST, {
        playerId: PLAYER_ID,
        recipeId: "bronze_shortsword",
        anvilId: "matrix-anvil",
        quantity: 1,
        requestId,
      });
      world.currentTick = tick + 4;
      system.update(0.6);
      break;
    case "crafting":
      world.emit(EventType.PROCESSING_CRAFTING_REQUEST, {
        playerId: PLAYER_ID,
        recipeId: "leather_gloves",
        quantity: 1,
        requestId,
      });
      world.currentTick = tick + 3;
      system.update(0.6);
      break;
    case "fletching":
      world.emit(EventType.PROCESSING_FLETCHING_REQUEST, {
        playerId: PLAYER_ID,
        recipeId: "arrow_shaft:logs",
        quantity: 1,
        requestId,
      });
      world.currentTick = tick + 3;
      system.update(0.6);
      break;
    case "runecrafting":
      world.emit(EventType.RUNECRAFTING_INTERACT, {
        playerId: PLAYER_ID,
        altarId: "matrix-air-altar",
        runeType: "air",
        requestId,
      });
      break;
    case "tanning":
      world.emit(EventType.TANNING_INTERACT, {
        playerId: PLAYER_ID,
        npcId: "tanner",
        npcEntityId: "matrix-tanner",
      });
      world.emit(EventType.TANNING_REQUEST, {
        playerId: PLAYER_ID,
        inputItemId: "cowhide",
        quantity: 2,
        requestId,
      });
      break;
    default:
      throw new Error(`unknown processing family: ${definition.family}`);
  }
  player.data.inStreamingDuel = false;
}

function updateAll(context, ticks = 1) {
  for (let count = 0; count < ticks; count += 1) {
    context.world.currentTick += 1;
    for (const name of SYSTEM_NAMES) {
      context.world.getSystem(name)?.update?.(0.6);
    }
  }
}

function relevantEvents(events, startIndex) {
  return events
    .slice(startIndex)
    .filter((event) => OBSERVED_EVENT_TYPES.has(event.type));
}

async function runCase(context, definition, caseIndex) {
  setInventory(context, definition.inputs);
  context.coinPouch.applyCommittedBalance(PLAYER_ID, 100);
  context.player.data.selectedSpell = "wind_strike";
  context.player.selectedSpell = "wind_strike";
  context.player.data.emote = "idle";
  const allSkills = context.skills.getSkills(PLAYER_ID);
  for (const skillName of SKILL_NAMES) {
    if (!allSkills?.[skillName]) continue;
    allSkills[skillName].level = 99;
  }
  context.world.emit(context.EventType.SKILLS_UPDATED, {
    playerId: PLAYER_ID,
    skills: allSkills,
  });

  const commitsBefore = context.commitCalls.length;
  const eventsBefore = context.events.length;
  const before = snapshotState(context);
  const requestId = `00000000-0000-5000-8000-${String(caseIndex + 1).padStart(12, "0")}`;
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    startCase(context, definition, requestId);
    await waitFor(
      () => context.commitCalls.length === commitsBefore + 1,
      `${definition.family} did not enter the durable-receipt window`,
      definition.family === "cooking" || definition.family === "firemaking"
        ? 20_000
        : 1_000,
    );
  } finally {
    Math.random = originalRandom;
  }

  const call = context.commitCalls.at(-1);
  const inFlight = snapshotState(context);
  assert(
    stableJson(snapshotRewardState(inFlight)) ===
      stableJson(snapshotRewardState(before)),
    `${definition.family} exposed reward state before receipt commit`,
    { before, inFlight },
  );
  assert(
    !context.isPlayerProcessingQuiescent(context.world, PLAYER_ID),
    `${definition.family} falsely reported quiescent during receipt commit`,
  );
  assert(
    currentPresentation(context.events)?.phase === "working",
    `${definition.family} did not publish a working presentation`,
    currentPresentation(context.events),
  );

  const quiescenceRequest = context.requestPlayerProcessingQuiescence(
    context.world,
    PLAYER_ID,
  );
  assert(
    quiescenceRequest.ok === true,
    `${definition.family} quiescence request failed`,
    quiescenceRequest,
  );
  const drainRequested = snapshotState(context);
  assert(
    !context.isPlayerProcessingQuiescent(context.world, PLAYER_ID),
    `${definition.family} discarded an in-flight durable receipt`,
  );
  assert(
    currentPresentation(context.events)?.phase === "idle",
    `${definition.family} presentation survived the quiescence request`,
    currentPresentation(context.events),
  );

  applyCommittedMutation(context, call);
  const held = context.heldReceipts.shift();
  assert(held, `${definition.family} held receipt was not recorded`);
  held.resolve(receiptFor(context, call));
  await flushPromises();
  updateAll(context, 2);
  await flushPromises();
  await waitFor(
    () => context.isPlayerProcessingQuiescent(context.world, PLAYER_ID),
    `${definition.family} did not drain to quiescence after receipt commit`,
  );

  const freeze = snapshotState(context);
  const freezeEventCount = context.events.length;
  updateAll(context, 64);
  await flushPromises();
  const after = snapshotState(context);
  assert(
    stableJson(after) === stableJson(freeze),
    `${definition.family} drifted after the authoritative freeze boundary`,
    { freeze, after },
  );
  assert(
    context.commitCalls.length === commitsBefore + 1,
    `${definition.family} launched a duplicate durable receipt`,
  );

  const caseEvents = relevantEvents(context.events, eventsBefore);
  const xpEvents = caseEvents.filter(
    (event) =>
      event.type === "xp:drop_broadcast" && event.data?.playerId === PLAYER_ID,
  );
  const completionEvents = caseEvents.filter(
    (event) =>
      event.type === definition.completionEvent &&
      event.data?.playerId === PLAYER_ID,
  );
  const rejectedEvents = caseEvents.filter(
    (event) => event.type === "processing:request:rejected",
  );
  const postFreezeWorking = context.events
    .slice(freezeEventCount)
    .filter(
      (event) =>
        event.type === "processing:interaction:presentation" &&
        event.data?.playerId === PLAYER_ID &&
        event.data?.phase === "working",
    );
  assert(
    xpEvents.length === definition.expectedXpEvents,
    `${definition.family} emitted an unexpected XP reward count`,
    xpEvents,
  );
  assert(
    completionEvents.length === 1,
    `${definition.family} emitted an unexpected completion count`,
    completionEvents,
  );
  assert(
    rejectedEvents.length === 0,
    `${definition.family} request was rejected`,
    rejectedEvents,
  );
  assert(
    postFreezeWorking.length === 0,
    `${definition.family} resurrected a station target after freeze`,
    postFreezeWorking,
  );

  return stable({
    family: definition.family,
    system: definition.system,
    requestId,
    operationId: call.operationId,
    quiescenceRequest,
    commit: {
      input: call.input,
      receiptCount: context.commitCalls.length - commitsBefore,
    },
    eventCounts: {
      completion: completionEvents.length,
      postFreezeWorking: postFreezeWorking.length,
      rejected: rejectedEvents.length,
      xp: xpEvents.length,
    },
    snapshots: { before, inFlight, drainRequested, freeze, after },
  });
}

function stationFootprintBounds(station, footprint) {
  const centerX = Math.floor(station.position.x);
  const centerZ = Math.floor(station.position.z);
  const minX = centerX - Math.floor(footprint.width / 2);
  const minZ = centerZ - Math.floor(footprint.depth / 2);
  return {
    centerX,
    centerZ,
    minX,
    maxX: minX + footprint.width - 1,
    minZ,
    maxZ: minZ + footprint.depth - 1,
  };
}

function isInsideFootprint(tile, bounds) {
  return (
    tile.x >= bounds.minX &&
    tile.x <= bounds.maxX &&
    tile.z >= bounds.minZ &&
    tile.z <= bounds.maxZ
  );
}

function selectPopulationStartTiles(world, station, footprint, count) {
  const bounds = stationFootprintBounds(station, footprint);
  const selected = [];
  const selectedKeys = new Set();
  for (let radius = 6; radius <= 18 && selected.length < count; radius += 1) {
    const candidates = [];
    for (let x = bounds.centerX - radius; x <= bounds.centerX + radius; x++) {
      candidates.push({ x, z: bounds.centerZ - radius });
      candidates.push({ x, z: bounds.centerZ + radius });
    }
    for (
      let z = bounds.centerZ - radius + 1;
      z < bounds.centerZ + radius;
      z++
    ) {
      candidates.push({ x: bounds.centerX - radius, z });
      candidates.push({ x: bounds.centerX + radius, z });
    }
    for (const tile of candidates) {
      const key = `${tile.x},${tile.z}`;
      if (
        selectedKeys.has(key) ||
        !world.collision.isWalkable(tile.x, tile.z) ||
        world.entityOccupancy.getOccupant(tile)
      ) {
        continue;
      }
      selectedKeys.add(key);
      selected.push(tile);
      if (selected.length === count) break;
    }
  }
  assert(
    selected.length === count,
    "production world lacked legal start tiles",
    {
      count,
      selected: selected.length,
      stationId: station.id,
    },
  );
  return selected;
}

function selectInteractionStartTile(world, station, footprint) {
  const bounds = stationFootprintBounds(station, footprint);
  const candidates = [];
  for (
    let distance = 1;
    distance <= station.getInteractionRange();
    distance++
  ) {
    for (let x = bounds.minX - distance; x <= bounds.maxX + distance; x++) {
      candidates.push({ x, z: bounds.minZ - distance });
      candidates.push({ x, z: bounds.maxZ + distance });
    }
    for (let z = bounds.minZ - distance + 1; z < bounds.maxZ + distance; z++) {
      candidates.push({ x: bounds.minX - distance, z });
      candidates.push({ x: bounds.maxX + distance, z });
    }
  }
  const selected = candidates
    .filter(
      (tile) =>
        world.collision.isWalkable(tile.x, tile.z) &&
        !world.entityOccupancy.getOccupant(tile) &&
        !isInsideFootprint(tile, bounds),
    )
    .sort(
      (left, right) =>
        (left.x - bounds.centerX) ** 2 +
          (left.z - bounds.centerZ) ** 2 -
          ((right.x - bounds.centerX) ** 2 + (right.z - bounds.centerZ) ** 2) ||
        left.x - right.x ||
        left.z - right.z,
    )[0];
  assert(selected, "production bank has no legal interaction start tile", {
    stationId: station.id,
    bounds,
  });
  return selected;
}

function inventoryQuantity(inventory, playerId, itemId) {
  return inventory
    .getInventoryData(playerId)
    .items.filter((entry) => entry.itemId === itemId)
    .reduce((total, entry) => total + entry.quantity, 0);
}

async function runPreparationVerticalSlice(context) {
  const {
    EventType,
    GATHERING_CONSTANTS,
    durableDatabase,
    events,
    getItem,
    inventory,
    isPlayerProcessingQuiescent,
    pgPool,
    skills,
    world,
  } = context;
  if (!durableDatabase || !pgPool) {
    return { status: "skipped", reason: "real_postgresql_required" };
  }
  const [
    { PendingGatherManager },
    { FaceDirectionManager },
    { EmbeddedHyperiaService },
    { AgentBehaviorBridge },
    { buildAgentAutonomyCheckpointDraft, saveAgentAutonomyCheckpoint },
    { selectReadablePreparationStagingPair },
    {
      beginAgentAutonomyProgressionAttempt,
      finalizeAgentAutonomyProgressionAttempt,
    },
  ] = await Promise.all([
    import("../src/systems/ServerNetwork/PendingGatherManager.ts"),
    import("../src/systems/ServerNetwork/FaceDirectionManager.ts"),
    import("../src/eliza/EmbeddedHyperiaService.ts"),
    import("../src/eliza/managers/AgentBehaviorBridge.ts"),
    import("../src/eliza/agentAutonomyCheckpoint.ts"),
    import("../src/eliza/preparationReadyStaging.ts"),
    import("../src/eliza/agentAutonomyProgression.ts"),
  ]);

  const resource = world.getSystem("resource");
  const network = world.getSystem("network");
  const database = world.getSystem("database");
  const terrain = world.getSystem("terrain");
  const bank = world.entities.get("station_bank_spawn");
  const range = world.entities.get("station_range_spawn");
  assert(
    resource &&
      typeof resource.relocateFishingSpot === "function" &&
      network &&
      database?.getDb?.() &&
      terrain?.getHeightAt &&
      bank &&
      range,
    "production preparation authorities are incomplete",
  );
  assert(
    typeof bank.getInteractionRange === "function" &&
      typeof bank.getInteractionFootprint === "function" &&
      typeof bank.canInteract === "function" &&
      typeof range.canInteract === "function",
    "production preparation station geometry is incomplete",
  );

  await waitFor(
    () => resource.getAvailableResourceByVariant?.("fishing_spot_net"),
    "authored net fishing spot did not become available",
    15_000,
  );
  const fishingSpot =
    resource.getAvailableResourceByVariant("fishing_spot_net");
  assert(fishingSpot, "authored net fishing spot disappeared before use");

  const startTile = selectInteractionStartTile(
    world,
    bank,
    bank.getInteractionFootprint(),
  );
  const startY = terrain.getHeightAt(startTile.x + 0.5, startTile.z + 0.5);
  assert(Number.isFinite(startY), "preparation start terrain height is absent");
  const player = world.entities.add({
    id: PREPARATION_AGENT_ID,
    type: "player",
    name: PREPARATION_AGENT_NAME,
    playerId: PREPARATION_AGENT_ID,
    playerName: PREPARATION_AGENT_NAME,
    position: [startTile.x + 0.5, startY, startTile.z + 0.5],
    quaternion: [0, 0, 0, 1],
    health: 10,
    maxHealth: 10,
    alive: true,
    isAgent: true,
    isEmbeddedAgent: true,
  });
  world.emit(EventType.PLAYER_REGISTERED, {
    playerId: PREPARATION_AGENT_ID,
  });
  world.emit(EventType.PLAYER_JOINED, {
    playerId: PREPARATION_AGENT_ID,
    player,
    isAgent: true,
    isEmbeddedAgent: true,
  });
  await waitFor(
    () => inventory.isInventoryReady(PREPARATION_AGENT_ID),
    "production preparation inventory initialization timed out",
    15_000,
  );
  await waitFor(
    () => skills.getSkills(PREPARATION_AGENT_ID)?.fishing,
    "production preparation skills initialization timed out",
    15_000,
  );
  const playerSkills = skills.getSkills(PREPARATION_AGENT_ID);
  world.emit(EventType.SKILLS_UPDATED, {
    playerId: PREPARATION_AGENT_ID,
    skills: playerSkills,
  });
  assert(
    bank.canInteract(PREPARATION_AGENT_ID, player.position),
    "preparation agent did not start at the physical bank boundary",
    { startTile, bankPosition: bank.position },
  );

  const movementPackets = [];
  const movementSamples = [
    { x: player.position.x, z: player.position.z, tick: world.currentTick },
  ];
  const movement = new TileMovementManager(world, (name, data) => {
    if (name === "tileMovementStart" || name === "tileMovementEnd") {
      movementPackets.push({ name, data: structuredClone(data) });
    }
  });
  movement.syncPlayerPosition(PREPARATION_AGENT_ID, player.position);
  const rotationPackets = [];
  const faceDirection = new FaceDirectionManager(world);
  faceDirection.setSendFunction((name, data) => {
    if (
      name === "entityModified" &&
      data?.id === PREPARATION_AGENT_ID &&
      Array.isArray(data?.changes?.q)
    ) {
      rotationPackets.push({ name, data: structuredClone(data) });
    }
  });
  const previousFaceDirectionManager = world.faceDirectionManager;
  world.faceDirectionManager = faceDirection;
  const pendingGather = new PendingGatherManager(
    world,
    movement,
    () => undefined,
  );
  const previousNetwork = {
    pendingGatherManager: network.pendingGatherManager,
    tickSystem: network.tickSystem,
    requestServerMove: network.requestServerMove,
    cancelServerMove: network.cancelServerMove,
  };
  const networkMoveRequests = [];
  network.pendingGatherManager = pendingGather;
  network.tickSystem = { getCurrentTick: () => world.currentTick };
  network.requestServerMove = (playerId, target, options = {}) => {
    const before = {
      tick: world.currentTick,
      x: player.position.x,
      z: player.position.z,
    };
    const accepted = movement.movePlayerToward(
      playerId,
      { x: target[0], y: target[1], z: target[2] },
      options.runMode ?? false,
      0,
      undefined,
      options.interactionArrival,
    );
    networkMoveRequests.push({
      before,
      target: [...target],
      runMode: options.runMode ?? false,
      interactionArrival: options.interactionArrival
        ? { ...options.interactionArrival }
        : null,
      accepted,
      movement: structuredClone(movement.getPerformanceContext()),
    });
    return accepted;
  };
  network.cancelServerMove = (playerId) => {
    movement.cleanup(playerId);
    return true;
  };

  const service = new EmbeddedHyperiaService(
    world,
    PREPARATION_AGENT_ID,
    PREPARATION_ACCOUNT_ID,
    PREPARATION_AGENT_NAME,
  );
  assert(
    service.attachExistingPlayer(),
    "production embedded service could not attach to preparation agent",
  );
  const instance = {
    config: {
      characterId: PREPARATION_AGENT_ID,
      accountId: PREPARATION_ACCOUNT_ID,
      name: PREPARATION_AGENT_NAME,
      scriptedRole: "gatherer",
      combatSpecialization: "melee",
      enableLlm: false,
    },
    service,
    state: "running",
    goal: null,
    memories: [],
    recentActionLog: [],
    tickCounter: 0,
    behaviorEpoch: 0,
    questsAccepted: new Set(
      PREPARATION_FORGING_QUEST ? PREPARATION_FORGING_PRECEDING_QUESTS : [],
    ),
    currentTargetId: null,
    lastCombatChatAt: 0,
    pendingChatReaction: null,
    lastGatherTargetId: null,
    lastGatherQueuedAt: 0,
    lastAteAt: 0,
    lastActivity: Date.now(),
    startedAt: Date.now(),
    pendingLlmResult: undefined,
    llmCallInFlight: false,
    navigationTarget: null,
    ordinaryProcessingRetries: [],
    ordinaryProcessingAcquisition: null,
    survivalFoodAcquisition: null,
    questEntryAcquisition: null,
    operatorCommandAt: 0,
    storeRetryAfter: 0,
    coinRecoveryAuthorizedAt: 0,
    attackObservationRetryAfter: 0,
    bankStageRetryAfter: 0,
    questCompleteFailures: new Map(),
  };
  const checkpoints = [];
  const db = database.getDb();
  const bridge = new AgentBehaviorBridge(
    world,
    (characterId) =>
      characterId === PREPARATION_AGENT_ID ? instance : undefined,
    () => [PREPARATION_AGENT_ID],
    async (current, actionResult, attempt) => {
      const now = Math.max(Date.now(), attempt?.startedAt ?? 0);
      const draft = buildAgentAutonomyCheckpointDraft(
        current,
        actionResult,
        now,
      );
      const checkpoint = attempt
        ? await finalizeAgentAutonomyProgressionAttempt(pgPool, attempt, draft)
        : await saveAgentAutonomyCheckpoint(db, draft);
      current.autonomyCheckpointRevision = checkpoint.revision;
      checkpoints.push({
        attemptedActionType: actionResult.attemptedActionType,
        appliedActionType: actionResult.appliedActionType,
        outcome: actionResult.outcome,
        attemptId: attempt?.attemptId ?? null,
        checkpointRevision: checkpoint.revision,
      });
    },
    (current, actionType, decisionSource) =>
      beginAgentAutonomyProgressionAttempt(pgPool, {
        characterId: current.config.characterId,
        goalType: current.goal?.type ?? null,
        actionType,
        decisionSource,
      }),
  );

  let firstGatherFacing = null;
  let maximumGatheringPending = 0;
  let maximumGatheringActive = 0;
  let forceRecoveryResourceMoveCancellation = false;
  let forcedRecoveryResourceMoveCancellationAttempted = false;
  let forcedRecoveryResourceMoveCancellationObserved = false;
  let initialGatherApproachActions = 0;
  let initialGatherApproachMoveActions = 0;
  let initialGatherApproachRejections = 0;
  let initialGatherCheckpointIndex = null;
  let bridgeStarted = false;
  const originalRandom = Math.random;
  Math.random = () => 0;
  const advanceWorldTick = async () => {
    world.currentTick += 1;
    faceDirection.resetMovementFlags();
    movement.onTick(world.currentTick);
    pendingGather.processTick(world.currentTick);
    const activePreparationGather =
      resource.activeGathering?.get(PREPARATION_AGENT_ID);
    if (
      forceRecoveryResourceMoveCancellation &&
      activePreparationGather?.resourceId === fishingSpot.id
    ) {
      forcedRecoveryResourceMoveCancellationAttempted = true;
      forceRecoveryResourceMoveCancellation = false;
      resource.stopGathering(
        { playerId: PREPARATION_AGENT_ID },
        "resource_moved",
      );
      forcedRecoveryResourceMoveCancellationObserved =
        !resource.activeGathering?.has(PREPARATION_AGENT_ID);
    }
    resource.processGatheringTick(world.currentTick);
    for (const systemName of SYSTEM_NAMES) {
      world.getSystem(systemName)?.update?.(0.6);
    }
    const facingPlayer = world.getPlayer?.(PREPARATION_AGENT_ID);
    const pendingFacing = facingPlayer
      ? {
          cardinal: facingPlayer.cardinalFaceDirection ?? null,
          target: facingPlayer.faceTarget
            ? { ...facingPlayer.faceTarget }
            : null,
        }
      : { cardinal: null, target: null };
    const rotationPacketsBefore = rotationPackets.length;
    faceDirection.processFaceDirection([PREPARATION_AGENT_ID]);
    movementSamples.push({
      x: player.position.x,
      z: player.position.z,
      tick: world.currentTick,
    });
    const custody = resource.getGatheringCustodyStats();
    maximumGatheringPending = Math.max(
      maximumGatheringPending,
      custody.pendingRewards,
    );
    maximumGatheringActive = Math.max(
      maximumGatheringActive,
      custody.activeSessions,
    );
    if (
      !firstGatherFacing &&
      custody.activeSessions > 0 &&
      rotationPackets.length > rotationPacketsBefore
    ) {
      const rotationPacket = rotationPackets.at(-1);
      firstGatherFacing = {
        ...pendingFacing,
        quaternion: [...rotationPacket.data.changes.q],
      };
    }
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 5));
  };

  const dispatchDecision = async (expectedActionTypes, description) => {
    // The acceptance world compresses many ordinary behavior cadences into a
    // single wall-clock second. Production naturally refreshes this cache
    // between decisions; make that boundary explicit here so every assertion
    // evaluates the latest authoritative movement and resource relocation.
    service.invalidateNearbyEntityCache();
    const before = checkpoints.length;
    const decisionInput = {
      worldTick: world.currentTick,
      gameState: structuredClone(service.getGameState()),
      inventoryItems: structuredClone(service.getInventoryItems()),
      equippedItems: structuredClone(service.getEquippedItems()),
      survivalFoodAcquisition: instance.survivalFoodAcquisition
        ? { ...instance.survivalFoodAcquisition }
        : null,
      ordinaryProcessingRetries: structuredClone(
        instance.ordinaryProcessingRetries,
      ),
      questState: structuredClone(service.getQuestState()),
      availableQuest: structuredClone(
        service
          .getAvailableQuests()
          .find((quest) => quest.questId === PREPARATION_FORGING_QUEST_ID) ??
          null,
      ),
      questCompleteFailures: instance.questCompleteFailures
        ? [...instance.questCompleteFailures.entries()]
        : [],
      goal: instance.goal ? structuredClone(instance.goal) : null,
    };
    const schedule = bridge.schedules.get(PREPARATION_AGENT_ID);
    assert(schedule, `missing bridge schedule before ${description}`);
    schedule.nextTickAt = 0;
    schedule.tickInProgress = false;
    let settled = false;
    let failure = null;
    const poll = bridge
      .pollAndDispatch()
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        settled = true;
      });
    const deadline = Date.now() + 30_000;
    while (!settled && Date.now() < deadline) await advanceWorldTick();
    assert(settled, `production bridge timed out during ${description}`, {
      decisionInput,
      custody: resource.getGatheringCustodyStats(),
      movement: movement.getPerformanceContext(),
    });
    await poll;
    if (failure) throw failure;
    assert(
      checkpoints.length === before + 1,
      `production bridge checkpoint count drifted during ${description}`,
      { before, after: checkpoints.length, checkpoints },
    );
    const result = checkpoints.at(-1);
    assert(
      expectedActionTypes.includes(result.attemptedActionType),
      `production worker selected the wrong action during ${description}`,
      { result, decisionInput },
    );
    return result;
  };

  try {
    await bridge.start();
    bridgeStarted = true;
    if (bridge.pollInterval) clearInterval(bridge.pollInterval);
    bridge.pollInterval = null;
    bridge.startAgent(PREPARATION_AGENT_ID);
    bridge.updateWorldScanCaches();

    const stagedTool = await dispatchDecision(
      ["bankWithdraw"],
      "private survival-tool staging",
    );
    assert(
      stagedTool.outcome === "completed" &&
        stagedTool.appliedActionType === "bankWithdraw" &&
        inventoryQuantity(
          inventory,
          PREPARATION_AGENT_ID,
          PREPARATION_TOOL_ID,
        ) === 1 &&
        instance.survivalFoodAcquisition?.expiresAt > Date.now(),
      "production bank miss did not stage and authorize the authored food tool",
      { stagedTool, survivalFoodAcquisition: instance.survivalFoodAcquisition },
    );

    let gathered = null;
    const initialGatherDeadline = Date.now() + 60_000;
    while (!gathered) {
      assert(
        Date.now() < initialGatherDeadline && initialGatherApproachActions < 12,
        "production food-resource approach exceeded its bounded replan budget",
        {
          initialGatherApproachActions,
          initialGatherApproachMoveActions,
          initialGatherApproachRejections,
          position: player.position,
          resourcePosition: fishingSpot.position,
          movement: movement.getPerformanceContext(),
        },
      );
      const beforeAction = { x: player.position.x, z: player.position.z };
      bridge.updateWorldScanCaches();
      const result = await dispatchDecision(
        ["move", "gather"],
        `authored food-resource approach ${initialGatherApproachActions + 1}`,
      );
      initialGatherApproachActions += 1;
      if (result.outcome === "rejected" && result.appliedActionType === null) {
        initialGatherApproachRejections += 1;
        assert(
          initialGatherApproachRejections <= 4,
          "production food-resource approach exhausted its transient rejection budget",
          {
            initialGatherApproachActions,
            initialGatherApproachRejections,
            result,
            position: player.position,
            resourcePosition: fishingSpot.position,
            movement: movement.getPerformanceContext(),
            networkMoveRequests: networkMoveRequests.slice(-6),
          },
        );
        await advanceWorldTick();
        continue;
      }
      if (result.appliedActionType === "move") {
        initialGatherApproachMoveActions += 1;
        assert(
          result.outcome === "dispatched",
          "production worker did not dispatch the food-resource approach",
          result,
        );
        const movementDeadline = Math.min(
          initialGatherDeadline,
          Date.now() + 20_000,
        );
        while (
          (movement.getPerformanceContext().activePaths > 0 ||
            movement.getPerformanceContext().pendingNonCombatMoves > 0) &&
          Date.now() < movementDeadline
        ) {
          await advanceWorldTick();
        }
        assert(
          player.position.x !== beforeAction.x ||
            player.position.z !== beforeAction.z,
          "production food-resource approach made no physical progress",
          {
            beforeAction,
            position: player.position,
            resourcePosition: fishingSpot.position,
            movement: movement.getPerformanceContext(),
            result,
          },
        );
        continue;
      }
      assert(
        result.outcome === "completed" &&
          result.appliedActionType === "gather" &&
          inventoryQuantity(
            inventory,
            PREPARATION_AGENT_ID,
            PREPARATION_RAW_FOOD_ID,
          ) >= 1,
        "production gather did not commit its first durable reward",
        result,
      );
      gathered = result;
      initialGatherCheckpointIndex = checkpoints.length - 1;
    }
    assert(
      initialGatherApproachMoveActions >= 1 &&
        initialGatherCheckpointIndex !== null,
      "authored food gathering did not prove physical resource navigation",
      {
        initialGatherApproachActions,
        initialGatherApproachMoveActions,
        initialGatherApproachRejections,
        initialGatherCheckpointIndex,
      },
    );

    const maxHealth = service.getGameState().maxHealth;
    const cookedHealAmount = Number(getItem(PREPARATION_FOOD_ID)?.healAmount);
    assert(
      Number.isFinite(maxHealth) &&
        maxHealth > 0 &&
        Number.isFinite(cookedHealAmount) &&
        cookedHealAmount > 0,
      "authored survival reserve metadata is invalid",
      { maxHealth, cookedHealAmount },
    );
    const rawRequired = Math.ceil(maxHealth / cookedHealAmount);
    const gatherDeadline = Date.now() + 20_000;
    while (
      inventoryQuantity(
        inventory,
        PREPARATION_AGENT_ID,
        PREPARATION_RAW_FOOD_ID,
      ) < rawRequired &&
      Date.now() < gatherDeadline
    ) {
      await advanceWorldTick();
    }
    assert(
      inventoryQuantity(
        inventory,
        PREPARATION_AGENT_ID,
        PREPARATION_RAW_FOOD_ID,
      ) >= rawRequired,
      "production gathering session did not acquire a full survival batch",
      {
        rawRequired,
        inventory: normalizeInventory(inventory, PREPARATION_AGENT_ID),
      },
    );

    let rangeApproachActions = 0;
    let rangeApproachRejections = 0;
    const rangeDeadline = Date.now() + 60_000;
    while (!range.canInteract(PREPARATION_AGENT_ID, player.position)) {
      assert(
        Date.now() < rangeDeadline && rangeApproachActions < 12,
        "production range approach exceeded its bounded replan budget",
        {
          rangeApproachActions,
          rangeApproachRejections,
          position: player.position,
          rangePosition: range.position,
          movement: movement.getPerformanceContext(),
        },
      );
      const beforeMove = { x: player.position.x, z: player.position.z };
      bridge.updateWorldScanCaches();
      const rangeMove = await dispatchDecision(
        ["move"],
        `range approach selection ${rangeApproachActions + 1}`,
      );
      rangeApproachActions += 1;
      if (
        rangeMove.outcome === "rejected" &&
        rangeMove.appliedActionType === null
      ) {
        rangeApproachRejections += 1;
        assert(
          rangeApproachRejections <= 4,
          "production range approach exhausted its transient rejection budget",
          {
            rangeApproachActions,
            rangeApproachRejections,
            position: player.position,
            rangePosition: range.position,
            movement: movement.getPerformanceContext(),
            rangeMove,
          },
        );
        // The ordinary worker runs again on its next cadence after a rejected
        // navigation target. Preserve that production behavior in the launch
        // proof instead of treating one safe rejection as a fatal shortcut.
        await advanceWorldTick();
        continue;
      }
      assert(
        rangeMove.outcome === "dispatched" &&
          rangeMove.appliedActionType === "move",
        "production worker did not dispatch the range approach",
        rangeMove,
      );
      const movementDeadline = Math.min(rangeDeadline, Date.now() + 20_000);
      while (
        !range.canInteract(PREPARATION_AGENT_ID, player.position) &&
        (movement.getPerformanceContext().activePaths > 0 ||
          movement.getPerformanceContext().pendingNonCombatMoves > 0) &&
        Date.now() < movementDeadline
      ) {
        await advanceWorldTick();
      }
      assert(
        range.canInteract(PREPARATION_AGENT_ID, player.position) ||
          player.position.x !== beforeMove.x ||
          player.position.z !== beforeMove.z,
        "production range approach replan made no physical progress",
        {
          rangeApproachActions,
          beforeMove,
          position: player.position,
          rangePosition: range.position,
          movement: movement.getPerformanceContext(),
        },
      );
    }
    assert(
      range.canInteract(PREPARATION_AGENT_ID, player.position),
      "physical preparation agent did not reach the production range",
      {
        rangeApproachActions,
        position: player.position,
        rangePosition: range.position,
      },
    );

    let cookingActions = 0;
    let recoveryGatherActions = 0;
    let recoveryGatherRejections = 0;
    const recoveryGatherFailureReasons = [];
    let recoveryMoveActions = 0;
    let recoveryMoveRejections = 0;
    let activeGatherWaits = 0;
    let recoveryIdleWaits = 0;
    let forcedBurnObserved = false;
    let recoveryDecisions = 0;
    const recoveryObservations = [];
    // A higher-constitution launch agent needs more successful cooking actions
    // than the level-one direct fixture. After the forced burn, each replacement
    // unit can require a gather decision, multiple physical chase/replans for a
    // moving fishing spot, a return-to-range decision, and the final cook. Size
    // this independent action ceiling for that production sequence rather than
    // classifying accepted movement progress as a stall. The wall-clock deadline
    // and the separate rejection/idle limits remain fail-closed bounds.
    const recoveryDecisionBudget = Math.min(
      128,
      Math.max(48, rawRequired * 4 + 16),
    );
    const recoveryDeadline = Date.now() + 60_000;
    while (
      inventoryQuantity(inventory, PREPARATION_AGENT_ID, PREPARATION_FOOD_ID) *
        cookedHealAmount <
      maxHealth
    ) {
      assert(
        Date.now() < recoveryDeadline &&
          recoveryDecisions < recoveryDecisionBudget,
        "production survival cooking recovery exceeded its bounded decision budget",
        {
          recoveryDecisions,
          recoveryDecisionBudget,
          cookingActions,
          recoveryGatherActions,
          recoveryGatherRejections,
          recoveryGatherFailureReasons,
          recoveryMoveActions,
          recoveryMoveRejections,
          recoveryIdleWaits,
          authoritativePosition: {
            x: player.position.x,
            y: player.position.y,
            z: player.position.z,
          },
          servicePosition: service.getGameState()?.position ?? null,
          rangePosition: {
            x: range.position.x,
            y: range.position.y,
            z: range.position.z,
          },
          rangeCanInteract: range.canInteract(
            PREPARATION_AGENT_ID,
            player.position,
          ),
          movement: movement.getPerformanceContext(),
          movementDebug: service.getMovementDebugState(),
          recoveryObservations: recoveryObservations.slice(-12),
          networkMoveRequests: networkMoveRequests.slice(-12),
          checkpoints: checkpoints.slice(-12),
          recoveryObservationTrace: JSON.stringify(
            recoveryObservations.slice(-12).map((observation) => ({
              decision: observation.decision,
              result: observation.result,
              before: observation.before,
              afterMovement:
                observation.afterMovement ?? observation.afterDispatch,
            })),
          ),
          networkMoveRequestTrace: JSON.stringify(
            networkMoveRequests.slice(-12),
          ),
          inventory: normalizeInventory(inventory, PREPARATION_AGENT_ID),
        },
      );
      recoveryDecisions += 1;
      bridge.updateWorldScanCaches();
      const observation = {
        decision: recoveryDecisions,
        before: {
          tick: world.currentTick,
          authoritativePosition: {
            x: player.position.x,
            y: player.position.y,
            z: player.position.z,
          },
          servicePosition: service.getGameState()?.position ?? null,
          rangeCanInteract: range.canInteract(
            PREPARATION_AGENT_ID,
            player.position,
          ),
          movement: structuredClone(movement.getPerformanceContext()),
          networkMoveRequestCount: networkMoveRequests.length,
        },
      };
      const cookedBefore = inventoryQuantity(
        inventory,
        PREPARATION_AGENT_ID,
        PREPARATION_FOOD_ID,
      );
      const burntBefore = inventoryQuantity(
        inventory,
        PREPARATION_AGENT_ID,
        PREPARATION_BURNT_FOOD_ID,
      );
      const rawBefore = inventoryQuantity(
        inventory,
        PREPARATION_AGENT_ID,
        PREPARATION_RAW_FOOD_ID,
      );
      const readyHealingBefore = cookedBefore * cookedHealAmount;
      const cookingReady =
        range.canInteract(PREPARATION_AGENT_ID, player.position) &&
        rawBefore > 0 &&
        readyHealingBefore + rawBefore * cookedHealAmount >= maxHealth;
      // A gathering result can already be committing when the worker leaves
      // the fishing spot, so the initial batch may exceed rawRequired by one.
      // Force authored burn outcomes only until that surplus is exhausted and
      // the ordinary policy has actually committed a replacement gather. This
      // proves recovery causally instead of depending on action scheduling.
      Math.random = cookingReady
        ? () => (recoveryGatherActions === 0 ? 0 : 0.999999)
        : () => 0;
      const decision = await dispatchDecision(
        ["cook", "gather", "move", "idle"],
        `survival reserve recovery decision ${recoveryDecisions}`,
      );
      observation.result = { ...decision };
      observation.afterDispatch = {
        tick: world.currentTick,
        authoritativePosition: {
          x: player.position.x,
          y: player.position.y,
          z: player.position.z,
        },
        servicePosition: service.getGameState()?.position ?? null,
        rangeCanInteract: range.canInteract(
          PREPARATION_AGENT_ID,
          player.position,
        ),
        movement: structuredClone(movement.getPerformanceContext()),
        networkMoveRequests: networkMoveRequests.slice(
          observation.before.networkMoveRequestCount,
        ),
      };
      if (decision.attemptedActionType === "cook") {
        assert(
          decision.outcome === "completed" &&
            decision.appliedActionType === "cook",
          "production cooking action did not commit",
          decision,
        );
        cookingActions += 1;
        const cookedAfter = inventoryQuantity(
          inventory,
          PREPARATION_AGENT_ID,
          PREPARATION_FOOD_ID,
        );
        const burntAfter = inventoryQuantity(
          inventory,
          PREPARATION_AGENT_ID,
          PREPARATION_BURNT_FOOD_ID,
        );
        if (burntAfter > burntBefore) {
          forcedBurnObserved = true;
          if (!forcedRecoveryResourceMoveCancellationAttempted) {
            forceRecoveryResourceMoveCancellation = true;
          }
        }
        assert(
          cookedAfter > cookedBefore || burntAfter > burntBefore,
          "production cook committed without an authored terminal output",
          { cookedBefore, cookedAfter, burntBefore, burntAfter },
        );
        recoveryObservations.push(observation);
        continue;
      }
      if (decision.attemptedActionType === "gather") {
        if (
          decision.outcome === "rejected" &&
          decision.appliedActionType === null
        ) {
          recoveryGatherRejections += 1;
          const failureReason = service.getLastGatherFailureReason();
          recoveryGatherFailureReasons.push(failureReason);
          const approvedTransientFailure =
            failureReason === "rate_limited" ||
            failureReason === "resource_moved";
          assert(
            recoveryGatherRejections <= 4 && approvedTransientFailure,
            "production burn recovery encountered an unapproved gather rejection",
            {
              decision,
              recoveryGatherRejections,
              recoveryGatherFailureReasons,
              custody: resource.getGatheringCustodyStats(),
              inventory: normalizeInventory(inventory, PREPARATION_AGENT_ID),
            },
          );
          // The production ticker advances no faster than one world tick, but
          // this acceptance world compresses ticks to milliseconds. Honor the
          // exact real-time anti-spam boundary only for a rate-limit rejection.
          // A moved fishing spot instead becomes visible on the next scan and
          // must be replanned without an artificial wall-clock delay. Both
          // branches still require a later durable replacement reward.
          if (failureReason === "rate_limited") {
            await new Promise((resolve) =>
              setTimeout(resolve, GATHERING_CONSTANTS.RATE_LIMIT_MS + 25),
            );
          }
          await advanceWorldTick();
          recoveryObservations.push(observation);
          continue;
        }
        assert(
          decision.outcome === "completed" &&
            decision.appliedActionType === "gather",
          "production burn recovery gather did not commit",
          decision,
        );
        recoveryGatherActions += 1;
        recoveryObservations.push(observation);
        continue;
      }
      if (decision.attemptedActionType === "move") {
        if (
          decision.outcome === "rejected" &&
          decision.appliedActionType === null
        ) {
          recoveryMoveRejections += 1;
          assert(
            recoveryMoveRejections <= 4,
            "production burn recovery exceeded its rejected movement budget",
            {
              decision,
              recoveryMoveRejections,
              authoritativePosition: {
                x: player.position.x,
                y: player.position.y,
                z: player.position.z,
              },
              servicePosition: service.getGameState()?.position ?? null,
              movement: movement.getPerformanceContext(),
              movementDebug: service.getMovementDebugState(),
              networkMoveRequests: networkMoveRequests.slice(
                observation.before.networkMoveRequestCount,
              ),
            },
          );
          // A blocked or already-invalidated worker target is a normal
          // fail-closed navigation outcome. Production retries on the next
          // cadence; the bounded decision/deadline gates and mandatory later
          // gather receipt prove that this cannot silently stall recovery.
          await advanceWorldTick();
          recoveryObservations.push(observation);
          continue;
        }
        assert(
          decision.outcome === "dispatched" &&
            decision.appliedActionType === "move",
          "production burn recovery movement was not dispatched",
          decision,
        );
        recoveryMoveActions += 1;
        const movementDeadline = Date.now() + 20_000;
        while (
          (movement.getPerformanceContext().activePaths > 0 ||
            movement.getPerformanceContext().pendingNonCombatMoves > 0) &&
          Date.now() < movementDeadline
        ) {
          await advanceWorldTick();
        }
        assert(
          movement.getPerformanceContext().activePaths === 0 &&
            movement.getPerformanceContext().pendingNonCombatMoves === 0,
          "production burn recovery movement did not settle",
          movement.getPerformanceContext(),
        );
        observation.afterMovement = {
          tick: world.currentTick,
          authoritativePosition: {
            x: player.position.x,
            y: player.position.y,
            z: player.position.z,
          },
          servicePosition: service.getGameState()?.position ?? null,
          rangeCanInteract: range.canInteract(
            PREPARATION_AGENT_ID,
            player.position,
          ),
          movement: structuredClone(movement.getPerformanceContext()),
          movementDebug: service.getMovementDebugState(),
        };
        recoveryObservations.push(observation);
        continue;
      }

      const gatheringBefore = inventoryQuantity(
        inventory,
        PREPARATION_AGENT_ID,
        PREPARATION_RAW_FOOD_ID,
      );
      if (resource.getGatheringCustodyStats().activeSessions === 0) {
        recoveryIdleWaits += 1;
        assert(
          recoveryIdleWaits <= 4,
          "production burn recovery exceeded its inactive wait budget",
          {
            decision,
            recoveryIdleWaits,
            recoveryGatherRejections,
            inventory: normalizeInventory(inventory, PREPARATION_AGENT_ID),
          },
        );
        await advanceWorldTick();
        recoveryObservations.push(observation);
        continue;
      }
      const waitDeadline = Date.now() + 20_000;
      while (
        inventoryQuantity(
          inventory,
          PREPARATION_AGENT_ID,
          PREPARATION_RAW_FOOD_ID,
        ) === gatheringBefore &&
        resource.getGatheringCustodyStats().activeSessions > 0 &&
        Date.now() < waitDeadline
      ) {
        await advanceWorldTick();
      }
      assert(
        inventoryQuantity(
          inventory,
          PREPARATION_AGENT_ID,
          PREPARATION_RAW_FOOD_ID,
        ) > gatheringBefore,
        "production worker idled without an active gather making progress",
        {
          decision,
          gatheringBefore,
          custody: resource.getGatheringCustodyStats(),
        },
      );
      activeGatherWaits += 1;
      recoveryObservations.push(observation);
    }
    assert(
      forcedBurnObserved &&
        forcedRecoveryResourceMoveCancellationAttempted &&
        forcedRecoveryResourceMoveCancellationObserved &&
        recoveryGatherFailureReasons.includes("resource_moved") &&
        recoveryGatherActions >= 1,
      "production slice did not prove deterministic burn recovery",
      {
        forcedBurnObserved,
        forcedRecoveryResourceMoveCancellationAttempted,
        forcedRecoveryResourceMoveCancellationObserved,
        recoveryDecisions,
        recoveryDecisionBudget,
        recoveryGatherActions,
        recoveryGatherRejections,
        recoveryGatherFailureReasons,
        recoveryMoveActions,
        recoveryMoveRejections,
        recoveryIdleWaits,
      },
    );

    // Recovery deliberately pins a high roll to prove deterministic cooking
    // outcomes. Restore the ordinary deterministic-success roll before the
    // independent forging slice starts gathering authored ore.
    Math.random = () => 0;

    let forgingExecution = null;
    if (PREPARATION_FORGING_QUEST) {
      const expectedStages = [
        "mine_copper",
        "mine_tin",
        "smelt_bronze",
        "smith_sword",
        "smith_hatchet",
        "smith_pickaxe",
        "return",
      ];
      const stageTrace = [];
      const actions = [];
      const gatheringContentionWaits = [];
      const observeQuest = () => {
        const active = service
          .getQuestState()
          .find((quest) => quest.questId === PREPARATION_FORGING_QUEST_ID);
        const available = service
          .getAvailableQuests()
          .find((quest) => quest.questId === PREPARATION_FORGING_QUEST_ID);
        const observation = {
          status: available?.status ?? active?.status ?? "missing",
          canStart: available?.canStart ?? false,
          currentStage: active?.currentStage ?? null,
          stageProgress: active?.stageProgress
            ? structuredClone(active.stageProgress)
            : null,
        };
        if (stableJson(stageTrace.at(-1) ?? null) !== stableJson(observation)) {
          stageTrace.push(observation);
        }
        return observation;
      };
      const questAvailabilityDeadline = Date.now() + 15_000;
      let initialQuest = observeQuest();
      while (
        (!initialQuest.canStart || initialQuest.status !== "not_started") &&
        Date.now() < questAvailabilityDeadline
      ) {
        await advanceWorldTick();
        initialQuest = observeQuest();
      }
      assert(
        initialQuest.status === "not_started" && initialQuest.canStart,
        "authored forging quest did not reach fresh startable state",
        initialQuest,
      );

      const forgingDeadline = Date.now() + 420_000;
      const forgingDecisionBudget = 160;
      let forgingDecisions = 0;
      while (true) {
        const quest = observeQuest();
        if (quest.status === "completed") break;
        assert(
          Date.now() < forgingDeadline &&
            forgingDecisions < forgingDecisionBudget,
          "ordinary forging quest exceeded its bounded completion budget",
          {
            forgingDecisions,
            forgingDecisionBudget,
            quest,
            stageTrace,
            actions: actions.slice(-20),
            inventory: normalizeInventory(inventory, PREPARATION_AGENT_ID),
            equipment: normalizeEquipment(
              world.getSystem("equipment"),
              PREPARATION_AGENT_ID,
            ),
            bank: normalizeBank(
              world.getSystem("banking"),
              PREPARATION_AGENT_ID,
            ),
            movement: movement.getPerformanceContext(),
          },
        );
        forgingDecisions += 1;
        bridge.updateWorldScanCaches();
        const action = await dispatchDecision(
          [
            "move",
            "questAccept",
            "questComplete",
            "gather",
            "smelt",
            "smith",
            "cook",
            "equip",
            "bankDepositAll",
            "idle",
          ],
          `authored forging quest decision ${forgingDecisions}`,
        );
        const gatherFailureReason =
          action.attemptedActionType === "gather" &&
          action.appliedActionType === null
            ? service.getLastGatherFailureReason()
            : null;
        actions.push({
          decision: forgingDecisions,
          quest,
          gatherFailureReason,
          ...action,
        });

        if (action.appliedActionType === "cook") {
          cookingActions += 1;
        } else if (action.appliedActionType === "move") {
          const movementDeadline = Date.now() + 30_000;
          while (
            (movement.getPerformanceContext().activePaths > 0 ||
              movement.getPerformanceContext().pendingNonCombatMoves > 0) &&
            Date.now() < movementDeadline
          ) {
            await advanceWorldTick();
          }
          assert(
            movement.getPerformanceContext().activePaths === 0 &&
              movement.getPerformanceContext().pendingNonCombatMoves === 0,
            "ordinary forging navigation did not settle",
            {
              quest,
              action,
              movement: movement.getPerformanceContext(),
              position: player.position,
            },
          );
        } else if (
          action.attemptedActionType === "gather" &&
          action.appliedActionType === null
        ) {
          assert(
            action.outcome === "rejected" &&
              ["rate_limited", "resource_unavailable"].includes(
                gatherFailureReason,
              ),
            "ordinary forging gather encountered an unapproved rejection",
            { quest, action, gatherFailureReason },
          );
          if (gatherFailureReason === "rate_limited") {
            await new Promise((resolve) =>
              setTimeout(resolve, GATHERING_CONSTANTS.RATE_LIMIT_MS + 25),
            );
          } else {
            const resourceVariant =
              quest.currentStage === "mine_copper"
                ? "ore_copper"
                : quest.currentStage === "mine_tin"
                  ? "ore_tin"
                  : null;
            const resourceEntityId = resourceVariant
              ? service
                  .getNearbyEntities()
                  .find((entity) => entity.resourceId === resourceVariant)?.id
              : null;
            assert(
              resourceEntityId,
              "contended forging gather lacked an exact authored resource identity",
              { quest, resourceVariant, gatherFailureReason },
            );
            const observedAt = Date.now();
            const persistedRespawn = await pgPool.query(
              `SELECT respawn_at::text AS "respawnAt"
                 FROM gathering_resource_states
                WHERE resource_id = $1 AND respawn_at > $2`,
              [resourceEntityId, observedAt],
            );
            const respawnAt = Number(persistedRespawn.rows[0]?.respawnAt);
            assert(
              Number.isSafeInteger(respawnAt) &&
                respawnAt > observedAt &&
                respawnAt - observedAt <= 60_000,
              "contended forging resource lacked a bounded durable respawn",
              {
                quest,
                resourceEntityId,
                observedAt,
                persistedRespawn: persistedRespawn.rows,
              },
            );
            const waitMs = Math.max(0, respawnAt - Date.now() + 25);
            gatheringContentionWaits.push({
              decision: forgingDecisions,
              resourceEntityId,
              respawnAt,
              waitMs,
            });
            if (waitMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
          }
        } else if (
          action.attemptedActionType === "idle" &&
          instance.lastGatherQueuedAt > 0
        ) {
          // Production ticks naturally span the anti-duplicate gather window.
          // The acceptance world compresses ticks to milliseconds, so wait out
          // only the exact remaining real-time window instead of clearing it.
          const gatherCooldownRemaining = Math.max(
            0,
            30_025 - (Date.now() - instance.lastGatherQueuedAt),
          );
          if (gatherCooldownRemaining > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, gatherCooldownRemaining),
            );
          }
        }

        for (let tick = 0; tick < 8; tick += 1) await advanceWorldTick();
      }

      let traceCursor = -1;
      for (const expectedStage of expectedStages) {
        traceCursor = stageTrace.findIndex(
          (entry, index) =>
            index > traceCursor && entry.currentStage === expectedStage,
        );
        assert(
          traceCursor >= 0,
          `ordinary forging quest skipped authored stage ${expectedStage}`,
          stageTrace,
        );
      }
      const actionCount = (actionType) =>
        actions.filter((entry) => entry.appliedActionType === actionType)
          .length;
      // Burn recovery can finish with bounded in-flight raw food. It may be
      // cooked before quest acceptance, but cooking must never interrupt an
      // authored forging stage.
      const setupCookingActions = actions.filter(
        (entry) => entry.appliedActionType === "cook",
      );
      const productiveQuestActionSequence = actions
        .filter(
          (entry) =>
            entry.appliedActionType !== null &&
            !["cook", "move", "bankDepositAll"].includes(
              entry.appliedActionType,
            ),
        )
        .map((entry) => entry.appliedActionType);
      const expectedProductiveQuestActionSequence = [
        "questAccept",
        ...Array(8).fill("gather"),
        ...Array(4).fill("smelt"),
        "smith",
        "equip",
        "smith",
        "smith",
        "questComplete",
      ];
      const actionTraceIsFailClosed = actions.every((entry, index) => {
        if (entry.attemptedActionType === "idle") {
          const previous = actions[index - 1];
          const next = actions[index + 1];
          return (
            entry.appliedActionType === null &&
            entry.outcome === "idle" &&
            entry.attemptId === null &&
            ["mine_copper", "mine_tin"].includes(entry.quest.currentStage) &&
            previous?.appliedActionType === "gather" &&
            next?.attemptedActionType === "gather" &&
            next.quest.currentStage === entry.quest.currentStage
          );
        }
        if (
          entry.attemptedActionType === "gather" &&
          entry.appliedActionType === null
        ) {
          return (
            entry.outcome === "rejected" &&
            ["rate_limited", "resource_unavailable"].includes(
              entry.gatherFailureReason,
            ) &&
            typeof entry.attemptId === "string"
          );
        }
        if (entry.appliedActionType === "move") {
          return (
            entry.attemptedActionType === "move" &&
            entry.outcome === "dispatched" &&
            typeof entry.attemptId === "string"
          );
        }
        return (
          entry.appliedActionType === entry.attemptedActionType &&
          entry.outcome === "completed" &&
          typeof entry.attemptId === "string"
        );
      });
      // One reward can finish while the initial food-gathering session is
      // winding down and one can finish while the mandatory burn-recovery
      // session winds down. The ordinary policy must cook those bounded
      // leftovers before accepting an unrelated quest, never during it.
      const maximumSetupCookingActions = 2;
      assert(
        actionCount("questAccept") === 1 &&
          actionCount("gather") === 8 &&
          actionCount("smelt") === 4 &&
          actionCount("smith") === 3 &&
          actionCount("equip") === 1 &&
          actionCount("bankDepositAll") <= 1 &&
          setupCookingActions.length <= maximumSetupCookingActions &&
          setupCookingActions.every(
            (entry) => entry.quest.status === "not_started",
          ) &&
          setupCookingActions.every(
            (entry, index) => actions[index] === entry,
          ) &&
          actionCount("questComplete") === 1 &&
          actionCount("move") >= 1 &&
          stableJson(productiveQuestActionSequence) ===
            stableJson(expectedProductiveQuestActionSequence) &&
          actionTraceIsFailClosed,
        "ordinary forging quest action sequence drifted",
        {
          actions,
          stageTrace,
          maximumSetupCookingActions,
          productiveQuestActionSequence,
          expectedProductiveQuestActionSequence,
          actionTraceIsFailClosed,
        },
      );
      forgingExecution = {
        status: "passed",
        questId: PREPARATION_FORGING_QUEST_ID,
        forgedWeaponId: PREPARATION_FORGED_WEAPON_ID,
        decisions: forgingDecisions,
        decisionBudget: forgingDecisionBudget,
        stageTrace,
        actions,
        gatheringContentionWaits,
        actionCounts: Object.fromEntries(
          [
            "move",
            "questAccept",
            "questComplete",
            "gather",
            "smelt",
            "smith",
            "cook",
            "equip",
            "bankDepositAll",
            "idle",
          ].map((actionType) => [actionType, actionCount(actionType)]),
        ),
      };
    }

    let readyStaging = null;
    if (PREPARATION_READY_SLOT !== null) {
      const staging = selectReadablePreparationStagingPair(
        stationFootprintBounds(range, range.getInteractionFootprint()),
        (tileX, tileZ) => world.collision.getFlags(tileX, tileZ),
      );
      assert(staging, "production world lacked a readable ready staging pair", {
        stationId: range.id,
      });
      const targetTile = staging.tiles[PREPARATION_READY_SLOT];
      const targetY = terrain.getHeightAt(
        targetTile.x + 0.5,
        targetTile.z + 0.5,
      );
      assert(
        Number.isFinite(targetY),
        "ready staging tile has no terrain height",
        { targetTile, slot: PREPARATION_READY_SLOT },
      );
      const currentTile = {
        x: Math.floor(player.position.x),
        z: Math.floor(player.position.z),
      };
      if (currentTile.x !== targetTile.x || currentTile.z !== targetTile.z) {
        const vacancyDeadline = Date.now() + 20_000;
        let targetOccupant = world.entityOccupancy.getOccupant(targetTile);
        while (
          targetOccupant &&
          String(targetOccupant.entityId) !== PREPARATION_AGENT_ID &&
          Date.now() < vacancyDeadline
        ) {
          await advanceWorldTick();
          targetOccupant = world.entityOccupancy.getOccupant(targetTile);
        }
        assert(
          !targetOccupant ||
            String(targetOccupant.entityId) === PREPARATION_AGENT_ID,
          "ready staging tile remained occupied",
          {
            slot: PREPARATION_READY_SLOT,
            targetTile,
            targetOccupant: targetOccupant
              ? {
                  entityId: String(targetOccupant.entityId),
                  entityType: targetOccupant.entityType ?? null,
                }
              : null,
            movement: movement.getPerformanceContext(),
          },
        );
        const accepted = network.requestServerMove(
          PREPARATION_AGENT_ID,
          [targetTile.x + 0.5, targetY, targetTile.z + 0.5],
          { runMode: false },
        );
        assert(accepted, "ready staging movement was rejected", {
          slot: PREPARATION_READY_SLOT,
          currentTile,
          targetTile,
          movement: movement.getPerformanceContext(),
        });
        const stagingDeadline = Date.now() + 20_000;
        while (
          (Math.floor(player.position.x) !== targetTile.x ||
            Math.floor(player.position.z) !== targetTile.z ||
            movement.getPerformanceContext().activePaths > 0 ||
            movement.getPerformanceContext().pendingNonCombatMoves > 0) &&
          Date.now() < stagingDeadline
        ) {
          await advanceWorldTick();
        }
      }
      const finalTile = {
        x: Math.floor(player.position.x),
        z: Math.floor(player.position.z),
      };
      assert(
        finalTile.x === targetTile.x && finalTile.z === targetTile.z,
        "preparation agent did not reach its distinct ready staging tile",
        {
          slot: PREPARATION_READY_SLOT,
          targetTile,
          finalTile,
          movement: movement.getPerformanceContext(),
        },
      );
      readyStaging = {
        slot: PREPARATION_READY_SLOT,
        pairSeparation: staging.separation,
        targetTile,
        finalTile,
      };
    }

    for (let tick = 0; tick < 4; tick++) await advanceWorldTick();
    const finalInventory = normalizeInventory(inventory, PREPARATION_AGENT_ID);
    const custody = resource.getGatheringCustodyStats();
    const movementContext = movement.getPerformanceContext();
    const preparationEvents = events.filter(
      (event) => event.data?.playerId === PREPARATION_AGENT_ID,
    );
    const eventCount = (type) =>
      preparationEvents.filter((event) => event.type === type).length;
    const usedDiagonalStep = movementSamples.some((sample, index) => {
      if (index === 0) return false;
      const previous = movementSamples[index - 1];
      return sample.x !== previous.x && sample.z !== previous.z;
    });
    const terminalActions = await pgPool.query(
      `SELECT action_type, action_outcome, applied_action_type, count(*)::int AS count
         FROM agent_autonomy_progression_events
        WHERE character_id = $1 AND event_type = 'attempt_terminal'
        GROUP BY action_type, action_outcome, applied_action_type
        ORDER BY action_type, action_outcome, applied_action_type`,
      [PREPARATION_AGENT_ID],
    );
    const persisted = await pgPool.query(
      `SELECT
         c."fishingXp"::float8 AS "fishingXp",
         c."cookingXp"::float8 AS "cookingXp",
         c."positionX"::float8 AS "positionX",
         c."positionY"::float8 AS "positionY",
         c."positionZ"::float8 AS "positionZ",
         COALESCE((SELECT sum(quantity)::int FROM inventory
           WHERE "playerId" = $1 AND "itemId" = $2), 0) AS tool,
         COALESCE((SELECT sum(quantity)::int FROM inventory
           WHERE "playerId" = $1 AND "itemId" = $3), 0) AS raw_food,
         COALESCE((SELECT sum(quantity)::int FROM inventory
           WHERE "playerId" = $1 AND "itemId" = $4), 0) AS cooked_food,
         COALESCE((SELECT sum(quantity)::int FROM inventory
           WHERE "playerId" = $1 AND "itemId" = $5), 0) +
         COALESCE((SELECT sum(quantity)::int FROM bank_storage
           WHERE "playerId" = $1 AND "itemId" = $5), 0) AS burnt_food,
         COALESCE((SELECT sum(quantity)::int FROM bank_storage
           WHERE "playerId" = $1 AND "itemId" = $5), 0) AS banked_burnt_food,
         COALESCE((SELECT sum(quantity)::int FROM bank_storage
           WHERE "playerId" = $1 AND "itemId" = $2), 0) AS banked_tool,
         (SELECT count(*)::int FROM agent_bank_operations
           WHERE "playerId" = $1 AND action = 'withdraw') AS bank_receipts,
         (SELECT count(*)::int FROM agent_bank_operations
           WHERE "playerId" = $1 AND action = 'deposit_all') AS deposit_receipts,
         (SELECT count(*)::int FROM operations_log
           WHERE "playerId" = $1 AND "operationType" = 'gathering_reward'
             AND completed = true) AS gathering_receipts,
         (SELECT count(*)::int FROM operations_log
           WHERE "playerId" = $1 AND "operationType" = 'processing_action'
             AND completed = true) AS processing_receipts,
         (SELECT open_attempt_id FROM agent_autonomy_progression_heads
           WHERE character_id = $1) AS open_attempt_id
       FROM characters c
       WHERE c.id = $1`,
      [
        PREPARATION_AGENT_ID,
        PREPARATION_TOOL_ID,
        PREPARATION_RAW_FOOD_ID,
        PREPARATION_FOOD_ID,
        PREPARATION_BURNT_FOOD_ID,
      ],
    );
    const row = persisted.rows[0];
    let forgingPersisted = null;
    if (forgingExecution) {
      const forgingResult = await pgPool.query(
        `WITH custody AS (
           SELECT "itemId" AS item_id, quantity FROM inventory
            WHERE "playerId" = $1
           UNION ALL
           SELECT "itemId" AS item_id, quantity FROM equipment
            WHERE "playerId" = $1
           UNION ALL
           SELECT "itemId" AS item_id, quantity FROM bank_storage
            WHERE "playerId" = $1
         ), item_totals AS (
           SELECT item_id, sum(quantity)::int AS quantity
             FROM custody GROUP BY item_id
         )
         SELECT quest.status,
                quest."currentStage" AS current_stage,
                character."miningXp"::float8 AS mining_xp,
                character."miningLevel"::int AS mining_level,
                character."smithingXp"::float8 AS smithing_xp,
                character."smithingLevel"::int AS smithing_level,
                character."questPoints"::int AS quest_points,
                COALESCE((SELECT quantity FROM item_totals
                           WHERE item_id = 'copper_ore'), 0) AS copper_ore,
                COALESCE((SELECT quantity FROM item_totals
                           WHERE item_id = 'tin_ore'), 0) AS tin_ore,
                COALESCE((SELECT quantity FROM item_totals
                           WHERE item_id = 'bronze_bar'), 0) AS bronze_bar,
                COALESCE((SELECT quantity FROM item_totals
                           WHERE item_id = 'bronze_shortsword'), 0)
                  AS bronze_shortsword,
                COALESCE((SELECT quantity FROM item_totals
                           WHERE item_id = 'bronze_hatchet'), 0)
                  AS bronze_hatchet,
                COALESCE((SELECT quantity FROM item_totals
                           WHERE item_id = 'bronze_pickaxe'), 0)
                  AS bronze_pickaxe,
                COALESCE((SELECT quantity FROM item_totals
                           WHERE item_id = 'hammer'), 0) AS hammer,
                COALESCE((SELECT quantity FROM item_totals
                           WHERE item_id = 'xp_lamp_100'), 0) AS xp_lamp,
                (SELECT count(*)::int
                   FROM quest_gathering_progress_receipts
                  WHERE player_id = $1 AND quest_id = $2)
                  AS gathering_receipts,
                (SELECT count(*)::int
                   FROM quest_gathering_progress_receipts
                  WHERE player_id = $1 AND quest_id = $2
                    AND resolved_at IS NULL)
                  AS unresolved_gathering_receipts,
                (SELECT count(*)::int
                   FROM quest_processing_progress_receipts
                  WHERE player_id = $1 AND quest_id = $2)
                  AS processing_receipts,
                (SELECT count(*)::int
                   FROM quest_processing_progress_receipts
                  WHERE player_id = $1 AND quest_id = $2
                    AND resolved_at IS NULL)
                  AS unresolved_processing_receipts,
                (SELECT count(*)::int FROM quest_audit_log
                  WHERE "playerId" = $1 AND "questId" = $2
                    AND action = 'started') AS started_audits,
                (SELECT count(*)::int FROM quest_audit_log
                  WHERE "playerId" = $1 AND "questId" = $2
                    AND action = 'completed') AS completed_audits
           FROM characters character
           JOIN quest_progress quest
             ON quest."playerId" = character.id AND quest."questId" = $2
          WHERE character.id = $1`,
        [PREPARATION_AGENT_ID, PREPARATION_FORGING_QUEST_ID],
      );
      forgingPersisted = forgingResult.rows[0] ?? null;
      assert(
        forgingPersisted &&
          forgingPersisted.status === "completed" &&
          Number(forgingPersisted.mining_xp) === 140 &&
          Number(forgingPersisted.mining_level) >= 2 &&
          Number(forgingPersisted.smithing_xp) > 0 &&
          Number(forgingPersisted.smithing_level) >= 1 &&
          Number(forgingPersisted.quest_points) === 1 &&
          Number(forgingPersisted.copper_ore) === 0 &&
          Number(forgingPersisted.tin_ore) === 0 &&
          Number(forgingPersisted.bronze_bar) === 0 &&
          Number(forgingPersisted.bronze_shortsword) === 1 &&
          Number(forgingPersisted.bronze_hatchet) === 1 &&
          Number(forgingPersisted.bronze_pickaxe) === 2 &&
          Number(forgingPersisted.hammer) === 1 &&
          Number(forgingPersisted.xp_lamp) === 1 &&
          Number(forgingPersisted.gathering_receipts) === 8 &&
          Number(forgingPersisted.unresolved_gathering_receipts) === 0 &&
          Number(forgingPersisted.processing_receipts) === 7 &&
          Number(forgingPersisted.unresolved_processing_receipts) === 0 &&
          Number(forgingPersisted.started_audits) === 1 &&
          Number(forgingPersisted.completed_audits) === 1,
        "PostgreSQL forging quest custody or progression drifted",
        { forgingExecution, forgingPersisted },
      );
    }
    assert(
      row &&
        Number(row.fishingXp) > 0 &&
        Number(row.cookingXp) > 0 &&
        Number(row.tool) === 1 &&
        Number(row.cooked_food) * cookedHealAmount >= maxHealth &&
        Number(row.burnt_food) >= 1 &&
        Number(row.banked_tool) === 0 &&
        Number(row.bank_receipts) === 1 &&
        Number(row.deposit_receipts) ===
          Number(forgingExecution?.actionCounts?.bankDepositAll ?? 0) &&
        (Number(row.deposit_receipts) === 0 ||
          Number(row.banked_burnt_food) >= 1) &&
        Number(row.gathering_receipts) >= rawRequired &&
        Number(row.processing_receipts) ===
          cookingActions + Number(forgingPersisted?.processing_receipts ?? 0) &&
        Math.abs(Number(row.positionX) - player.position.x) <= 0.001 &&
        Math.abs(Number(row.positionY) - player.position.y) <= 0.001 &&
        Math.abs(Number(row.positionZ) - player.position.z) <= 0.001 &&
        row.open_attempt_id === null,
      "PostgreSQL preparation custody or progression drifted",
      {
        row,
        cookingActions,
        recoveryGatherActions,
        recoveryGatherRejections,
        recoveryGatherFailureReasons,
        recoveryMoveActions,
        recoveryMoveRejections,
        recoveryIdleWaits,
        rawRequired,
        terminalActions: terminalActions.rows,
      },
    );
    assert(
      custody.activeSessions === 0 &&
        custody.pendingRewards === 0 &&
        custody.resourceReservations === 0 &&
        pendingGather.pendingGathers.size === 0 &&
        movementContext.activePaths === 0 &&
        movementContext.pendingNonCombatMoves === 0 &&
        isPlayerProcessingQuiescent(world, PREPARATION_AGENT_ID),
      "preparation vertical slice did not drain to quiescence",
      { custody, movementContext },
    );
    assert(
      firstGatherFacing &&
        eventCount("resource:gathering:started") >= 1 &&
        eventCount("resource:gathering:completed") >= rawRequired &&
        eventCount("gathering:tool:show") >= 1 &&
        eventCount("gathering:tool:hide") >= 1 &&
        eventCount("fishing:interaction:presentation") >= 1 &&
        eventCount("cooking:completed") === cookingActions &&
        eventCount("processing:request:rejected") === 0 &&
        usedDiagonalStep,
      "preparation movement or presentation evidence is incomplete",
      {
        firstGatherFacing,
        eventCounts: Object.fromEntries(
          [...OBSERVED_EVENT_TYPES].map((type) => [type, eventCount(type)]),
        ),
        usedDiagonalStep,
      },
    );

    return stable({
      status: "passed",
      playerId: PREPARATION_AGENT_ID,
      authoredResource: {
        id: fishingSpot.id,
        variant: "fishing_spot_net",
        position: fishingSpot.position,
      },
      stations: {
        bank: bank.id,
        range: range.id,
      },
      workerBridge: {
        checkpoints,
        terminalActions: terminalActions.rows,
        exactOpenAttemptCount: 0,
      },
      movement: {
        samples: movementSamples.length,
        diagonalStep: usedDiagonalStep,
        rangeApproachActions,
        rangeApproachRejections,
        readyStaging,
        packets: {
          starts: movementPackets.filter(
            (packet) => packet.name === "tileMovementStart",
          ).length,
          ends: movementPackets.filter(
            (packet) => packet.name === "tileMovementEnd",
          ).length,
        },
        finalPosition: {
          x: player.position.x,
          y: player.position.y,
          z: player.position.z,
        },
        persistedPosition: {
          x: Number(row.positionX),
          y: Number(row.positionY),
          z: Number(row.positionZ),
        },
      },
      gathering: {
        rawRequired,
        initialApproachActions: initialGatherApproachActions,
        initialApproachMoveActions: initialGatherApproachMoveActions,
        initialApproachRejections: initialGatherApproachRejections,
        initialGatherCheckpointIndex,
        maximumActiveSessions: maximumGatheringActive,
        maximumPendingRewards: maximumGatheringPending,
        durableReceipts: Number(row.gathering_receipts),
        firstFacing: firstGatherFacing,
        drained: custody,
      },
      cooking: {
        actions: cookingActions,
        successfulOutputs: Number(row.cooked_food),
        burntOutputs: Number(row.burnt_food),
        forcedBurnObserved,
        forcedRecoveryResourceMoveCancellationAttempted,
        forcedRecoveryResourceMoveCancellationObserved,
        recoveryDecisions,
        recoveryDecisionBudget,
        recoveryGatherActions,
        recoveryGatherRejections,
        recoveryGatherFailureReasons,
        recoveryMoveActions,
        recoveryMoveRejections,
        activeGatherWaits,
        recoveryIdleWaits,
        durableReceipts: cookingActions,
        cookedHealing: Number(row.cooked_food) * Number(cookedHealAmount),
        requiredHealing: Number(maxHealth),
      },
      forging: forgingExecution
        ? {
            ...forgingExecution,
            persisted: forgingPersisted,
            gatheringReceipts: Number(
              forgingPersisted?.gathering_receipts ?? 0,
            ),
            processingReceipts: Number(
              forgingPersisted?.processing_receipts ?? 0,
            ),
          }
        : { status: "skipped", reason: "forging_quest_not_requested" },
      processing: {
        durableReceipts: Number(row.processing_receipts),
      },
      custody: {
        liveInventory: finalInventory,
        persisted: row,
      },
      presentation: {
        gatheringStarts: eventCount("resource:gathering:started"),
        gatheringCompletions: eventCount("resource:gathering:completed"),
        toolShows: eventCount("gathering:tool:show"),
        toolHides: eventCount("gathering:tool:hide"),
        fishingTransitions: eventCount("fishing:interaction:presentation"),
        rotationPackets: rotationPackets.length,
        cookingCompletions: eventCount("cooking:completed"),
        processingRejections: eventCount("processing:request:rejected"),
      },
      exactFinalCustodyAndXp: true,
      quiescent: true,
    });
  } finally {
    Math.random = originalRandom;
    if (bridgeStarted) bridge.stop();
    service.detachExistingPlayer();
    pendingGather.onPlayerDisconnect(PREPARATION_AGENT_ID);
    movement.cleanup(PREPARATION_AGENT_ID);
    world.faceDirectionManager = previousFaceDirectionManager;
    network.pendingGatherManager = previousNetwork.pendingGatherManager;
    network.tickSystem = previousNetwork.tickSystem;
    network.requestServerMove = previousNetwork.requestServerMove;
    network.cancelServerMove = previousNetwork.cancelServerMove;
  }
}

async function runPopulationStationCase(context) {
  const {
    EventType,
    canPlayerPerformPreparationAction,
    durableDatabase,
    events,
    inventory,
    pgPool,
    skills,
    world,
  } = context;
  const station = world.entities.get("station_range_spawn");
  assert(station, "production range station was not spawned");
  assert(station.entityType === "range", "production range identity drifted", {
    entityType: station.entityType,
  });
  assert(
    typeof station.getInteractionRange === "function" &&
      typeof station.getInteractionFootprint === "function" &&
      typeof station.canInteract === "function",
    "production range lacks interaction geometry",
  );
  const interactionRange = station.getInteractionRange();
  const footprint = station.getInteractionFootprint();
  assert(
    Number.isSafeInteger(footprint.width) &&
      footprint.width > 0 &&
      Number.isSafeInteger(footprint.depth) &&
      footprint.depth > 0 &&
      Number.isFinite(interactionRange) &&
      interactionRange >= 1,
    "production range interaction geometry is invalid",
    { footprint, interactionRange },
  );
  const bounds = stationFootprintBounds(station, footprint);
  const terrain = world.getSystem("terrain");
  assert(
    typeof terrain?.getHeightAt === "function",
    "production terrain height authority is missing",
  );
  const startTiles = selectPopulationStartTiles(
    world,
    station,
    footprint,
    POPULATION_SIZE,
  );
  const playerIds = Array.from(
    { length: POPULATION_SIZE },
    (_, index) => `${POPULATION_PREFIX}${String(index).padStart(2, "0")}`,
  );
  if (durableDatabase) {
    assert(pgPool, "PostgreSQL population pool is missing");
    await seedDurablePlayers(
      pgPool,
      playerIds.map((playerId, index) => ({
        playerId,
        name: `Launch Station Agent ${index + 1}`,
        cookingLevel: 99,
        rawShrimp: true,
      })),
    );
  }
  const players = new Map();
  for (let index = 0; index < playerIds.length; index += 1) {
    const playerId = playerIds[index];
    const tile = startTiles[index];
    const height = terrain.getHeightAt(tile.x + 0.5, tile.z + 0.5);
    assert(Number.isFinite(height), `missing terrain height for ${playerId}`);
    const player = world.entities.add({
      id: playerId,
      type: "player",
      name: `Launch Station Agent ${index + 1}`,
      playerId,
      playerName: `Launch Station Agent ${index + 1}`,
      position: [tile.x + 0.5, height, tile.z + 0.5],
      quaternion: [0, 0, 0, 1],
      isAgent: true,
      isEmbeddedAgent: true,
    });
    players.set(playerId, player);
    world.emit(EventType.PLAYER_REGISTERED, { playerId });
    world.emit(EventType.PLAYER_JOINED, {
      playerId,
      player,
      ...(durableDatabase
        ? {}
        : {
            inventory: [{ slotIndex: 0, itemId: "raw_shrimp", quantity: 1 }],
          }),
      equipment: [],
      isAgent: true,
    });
  }
  await waitFor(
    () => playerIds.every((playerId) => inventory.isInventoryReady(playerId)),
    "production population inventory initialization timed out",
    15_000,
  );
  for (const playerId of playerIds) {
    const allSkills = skills.getSkills(playerId);
    assert(allSkills?.cooking, `cooking skill missing for ${playerId}`);
    allSkills.cooking.level = 99;
    world.emit(EventType.SKILLS_UPDATED, { playerId, skills: allSkills });
  }

  const movementPackets = [];
  const movement = new TileMovementManager(world, (name, data) => {
    if (name === "tileMovementStart" || name === "tileMovementEnd") {
      movementPackets.push({ name, data: structuredClone(data) });
    }
  });
  for (let index = 0; index < playerIds.length; index += 1) {
    const playerId = playerIds[index];
    movement.syncPlayerPosition(playerId, players.get(playerId).position);
    movement.movePlayerToward(playerId, station.position, true, 0, undefined, {
      interactionRange,
      footprintWidth: footprint.width,
      footprintDepth: footprint.depth,
    });
  }

  const populationSet = new Set(playerIds);
  const eventsBefore = events.length;
  const submitted = new Set();
  const completed = new Set();
  const departureRequested = new Set();
  const departed = new Set();
  const arrivalTickByAgent = new Map();
  const completionTickByAgent = new Map();
  const departureTickByAgent = new Map();
  const departureRequestAttempts = new Map();
  const commitCalls = [];
  const operationIds = new Set();
  let maximumActivePaths = 0;
  let maximumPendingMoves = 0;
  let maximumAgentsInRange = 0;
  let performanceEvidence;
  const requestDeparture = (playerId) => {
    const attempts = (departureRequestAttempts.get(playerId) ?? 0) + 1;
    departureRequestAttempts.set(playerId, attempts);
    assert(
      attempts <= 5,
      `departure replanning exceeded its bound for ${playerId}`,
      {
        attempts,
        tile: movement.getCurrentTile(playerId),
        position: players.get(playerId)?.position,
      },
    );
    const departureTile = startTiles[playerIds.indexOf(playerId)];
    assert(
      movement.movePlayerToward(
        playerId,
        {
          x: departureTile.x + 0.5,
          y: players.get(playerId).position.y,
          z: departureTile.z + 0.5,
        },
        true,
      ),
      `departure movement was rejected for ${playerId}`,
      { attempts, departureTile },
    );
  };
  const originalCommit = inventory.commitProcessingActionAtomic.bind(inventory);
  inventory.commitProcessingActionAtomic = async (
    playerId,
    operationId,
    input,
  ) => {
    if (!populationSet.has(playerId)) {
      return originalCommit(playerId, operationId, input);
    }
    const call = {
      playerId,
      operationId,
      input: structuredClone(input),
    };
    assert(
      !operationIds.has(operationId),
      "duplicate population operation ID",
      {
        operationId,
      },
    );
    operationIds.add(operationId);
    commitCalls.push(call);
    if (!durableDatabase) {
      applyCommittedMutation(context, call);
      return receiptFor(context, call);
    }
    const receipt = await originalCommit(playerId, operationId, input);
    assert(
      receipt?.ok === true &&
        receipt.committed === true &&
        receipt.liveInventoryApplied === true &&
        receipt.replayed === false &&
        receipt.playerId === playerId &&
        receipt.operationId === operationId,
      "PostgreSQL population receipt did not commit and converge exactly",
      { playerId, operationId, receipt },
    );
    call.receipt = structuredClone(receipt);
    return receipt;
  };

  const originalRandom = Math.random;
  world.enableSystemTiming();
  world.resetServerTimingPercentiles();
  Math.random = () => 0;
  try {
    for (
      let populationTick = 1;
      populationTick <= POPULATION_MAX_TICKS &&
      (completed.size < POPULATION_SIZE || departed.size < POPULATION_SIZE);
      populationTick += 1
    ) {
      world.currentTick += 1;
      movement.onTick(world.currentTick);
      const occupiedTiles = new Set();
      let agentsInRange = 0;
      for (const playerId of playerIds) {
        const tile = movement.getCurrentTile(playerId);
        assert(tile, `movement state disappeared for ${playerId}`);
        const tileKey = `${tile.x},${tile.z}`;
        assert(
          !occupiedTiles.has(tileKey),
          "population players shared one physical tile",
          { playerId, tile },
        );
        occupiedTiles.add(tileKey);
        assert(
          !isInsideFootprint(tile, bounds),
          "population player entered the station footprint",
          { playerId, tile, bounds },
        );
        const inRange =
          canPlayerPerformPreparationAction(world, playerId) &&
          station.canInteract(playerId, players.get(playerId).position);
        if (inRange) agentsInRange += 1;
        if (
          departureRequested.has(playerId) &&
          inRange &&
          !departed.has(playerId) &&
          players.get(playerId).data?.tileMovementActive !== true
        ) {
          requestDeparture(playerId);
        }
        if (
          departureRequested.has(playerId) &&
          !inRange &&
          !departed.has(playerId)
        ) {
          departed.add(playerId);
          departureTickByAgent.set(playerId, populationTick);
        }
        if (!submitted.has(playerId) && inRange) {
          const fish = inventory
            .getInventory(playerId)
            ?.items.find((entry) => entry.itemId === "raw_shrimp");
          assert(fish, `raw shrimp custody missing for ${playerId}`);
          const requestId = `10000000-0000-4000-8000-${String(submitted.size + 1).padStart(12, "0")}`;
          world.emit(EventType.PROCESSING_COOKING_REQUEST, {
            playerId,
            fishSlot: fish.slot,
            rangeId: station.id,
            sourceType: "range",
            requestId,
          });
          submitted.add(playerId);
          arrivalTickByAgent.set(playerId, populationTick);
        }
      }
      maximumAgentsInRange = Math.max(maximumAgentsInRange, agentsInRange);
      for (const name of SYSTEM_NAMES) {
        world.getSystem(name)?.update?.(0.6);
      }
      await flushPromises();
      for (const event of events.slice(eventsBefore)) {
        if (
          event.type !== "cooking:completed" ||
          !populationSet.has(event.data?.playerId) ||
          completed.has(event.data.playerId)
        ) {
          continue;
        }
        completed.add(event.data.playerId);
        completionTickByAgent.set(event.data.playerId, populationTick);
        departureRequested.add(event.data.playerId);
        requestDeparture(event.data.playerId);
      }
      const performance = movement.getPerformanceContext();
      maximumActivePaths = Math.max(
        maximumActivePaths,
        performance.activePaths,
      );
      maximumPendingMoves = Math.max(
        maximumPendingMoves,
        performance.pendingNonCombatMoves,
      );
      await new Promise((resolve) => setTimeout(resolve, POPULATION_TICK_MS));
    }
  } finally {
    performanceEvidence = stable({
      existingWorldTickWarningThresholdMs: WORLD_TICK_WARNING_THRESHOLD_MS,
      worldTicks: world.getServerTickTimingPercentiles(),
      slowestSystems: world.getSystemTimingPercentiles().slice(0, 10),
    });
    world.disableSystemTiming();
    Math.random = originalRandom;
    inventory.commitProcessingActionAtomic = originalCommit;
  }

  assert(
    performanceEvidence.worldTicks.total.samples >=
      MIN_POPULATION_WORLD_TICK_SAMPLES,
    "population run did not retain enough production world-tick samples",
    performanceEvidence,
  );
  assert(
    performanceEvidence.worldTicks.total.max <= WORLD_TICK_WARNING_THRESHOLD_MS,
    "population run crossed the existing severe world-tick warning threshold",
    performanceEvidence,
  );

  const populationEvents = events.slice(eventsBefore);
  const rejections = populationEvents.filter(
    (event) =>
      event.type === "processing:request:rejected" &&
      populationSet.has(event.data?.playerId),
  );
  assert(
    submitted.size === POPULATION_SIZE,
    "not every agent reached the range",
    {
      submitted: submitted.size,
      completed: completed.size,
      departed: departed.size,
      commitCalls: commitCalls.length,
      currentMovement: movement.getPerformanceContext(),
      arrivalTickByAgent: Object.fromEntries(arrivalTickByAgent),
      completionTickByAgent: Object.fromEntries(completionTickByAgent),
      departureTickByAgent: Object.fromEntries(departureTickByAgent),
    },
  );
  assert(
    completed.size === POPULATION_SIZE,
    "not every admitted cooking action completed",
    {
      completed: completed.size,
      submitted: submitted.size,
      rejections,
    },
  );
  assert(
    departed.size === POPULATION_SIZE,
    "not every completed agent cleared the range for the next wave",
    {
      completed: completed.size,
      departed: departed.size,
      departureTickByAgent: Object.fromEntries(departureTickByAgent),
      departureRequestAttempts: Object.fromEntries(departureRequestAttempts),
    },
  );
  assert(rejections.length === 0, "population processing was rejected", {
    rejections,
  });
  assert(
    commitCalls.length === POPULATION_SIZE &&
      operationIds.size === POPULATION_SIZE,
    "population durable-receipt identities were not one-to-one",
    { commitCalls: commitCalls.length, operationIds: operationIds.size },
  );

  const agents = playerIds.map((playerId) => {
    const inventoryState = normalizeInventory(inventory, playerId);
    const cooking = skills.getSkillData(playerId, "cooking");
    assert(
      inventoryState.length === 1 &&
        inventoryState[0].itemId === "shrimp" &&
        inventoryState[0].quantity === 1,
      `final cooking custody drifted for ${playerId}`,
      inventoryState,
    );
    assert(
      Number.isFinite(cooking?.xp) && cooking.xp > 0,
      `cooking XP did not commit for ${playerId}`,
      cooking,
    );
    return {
      playerId,
      arrivalTick: arrivalTickByAgent.get(playerId),
      completionTick: completionTickByAgent.get(playerId),
      departureTick: departureTickByAgent.get(playerId),
      cookingXp: cooking.xp,
      inventory: inventoryState,
    };
  });
  let durablePersistence = {
    mode: "controlled_receipt",
    exactFinalCustodyAndXp: true,
  };
  if (durableDatabase) {
    const persisted = await pgPool.query(
      `SELECT c.id,
              c."cookingXp" AS "cookingXp",
              c."cookingLevel" AS "cookingLevel",
              i."itemId" AS "itemId",
              i.quantity,
              i."slotIndex" AS "slotIndex"
         FROM characters c
         LEFT JOIN inventory i ON i."playerId" = c.id
        WHERE c.id = ANY($1::text[])
        ORDER BY c.id, i."slotIndex"`,
      [playerIds],
    );
    const persistedByPlayer = new Map(
      playerIds.map((playerId) => [
        playerId,
        { cookingXp: null, cookingLevel: null, inventory: [] },
      ]),
    );
    for (const row of persisted.rows) {
      const state = persistedByPlayer.get(row.id);
      assert(state, "PostgreSQL returned an unexpected population player", row);
      state.cookingXp = Number(row.cookingXp);
      state.cookingLevel = Number(row.cookingLevel);
      if (row.itemId !== null) {
        state.inventory.push({
          itemId: row.itemId,
          quantity: Number(row.quantity),
          slotIndex: Number(row.slotIndex),
        });
      }
    }
    for (const [playerId, state] of persistedByPlayer) {
      assert(
        Number.isFinite(state.cookingXp) &&
          state.cookingXp > 0 &&
          Number.isSafeInteger(state.cookingLevel) &&
          state.cookingLevel >= 1 &&
          state.inventory.length === 1 &&
          state.inventory[0].itemId === "shrimp" &&
          state.inventory[0].quantity === 1 &&
          state.inventory[0].slotIndex === 0,
        `PostgreSQL final cooking custody drifted for ${playerId}`,
        state,
      );
    }
    const operationRows = await pgPool.query(
      `SELECT "playerId", "operationType", completed, count(*)::int AS count
         FROM operations_log
        WHERE "playerId" = ANY($1::text[])
        GROUP BY "playerId", "operationType", completed
        ORDER BY "playerId", "operationType", completed`,
      [playerIds],
    );
    assert(
      operationRows.rows.length === POPULATION_SIZE &&
        operationRows.rows.every(
          (row) =>
            row.operationType === "processing_action" &&
            row.completed === true &&
            Number(row.count) === 1,
        ),
      "PostgreSQL population operation receipts were not exact",
      operationRows.rows,
    );
    durablePersistence = {
      mode: "postgresql",
      exactFinalCustodyAndXp: true,
      characterRows: persistedByPlayer.size,
      completedOperationReceipts: operationRows.rows.length,
      oneReceiptPerPlayer: true,
      pendingOperationReceipts: 0,
    };
  }
  for (const playerId of playerIds) movement.cleanup(playerId);

  return stable({
    station: {
      id: station.id,
      entityType: station.entityType,
      position: {
        x: station.position.x,
        y: station.position.y,
        z: station.position.z,
      },
      interactionRange,
      footprint,
    },
    population: POPULATION_SIZE,
    movement: {
      maximumActivePaths,
      maximumPendingMoves,
      maximumAgentsInRange,
      packets: {
        starts: movementPackets.filter(
          (packet) => packet.name === "tileMovementStart",
        ).length,
        ends: movementPackets.filter(
          (packet) => packet.name === "tileMovementEnd",
        ).length,
      },
      latestArrivalTick: Math.max(...arrivalTickByAgent.values()),
      latestDepartureTick: Math.max(...departureTickByAgent.values()),
      maximumDepartureRequests: Math.max(...departureRequestAttempts.values()),
      departureRequestAttempts: Object.fromEntries(departureRequestAttempts),
      uniqueAndOutsideFootprintEveryTick: true,
      everyCompletedAgentClearedRange: true,
    },
    processing: {
      submissions: submitted.size,
      completions: completed.size,
      rejections: rejections.length,
      receiptCount: commitCalls.length,
      uniqueOperationIds: operationIds.size,
      exactFinalCustodyAndXp: true,
      persistence: durablePersistence,
    },
    performance: performanceEvidence,
    agents,
  });
}

async function main() {
  process.chdir(path.join(SERVER_DIR, "world"));
  const frameworkBytes = await readFile(FRAMEWORK_PATH);
  const frameworkStat = await stat(FRAMEWORK_PATH);
  assert(
    frameworkBytes.byteLength > 1_000_000,
    "production framework is absent",
  );
  const workspace = await mkdtemp(
    path.join(tmpdir(), "hyperia-processing-live-world-"),
  );
  emitPreparationProgress("workspace_created");
  const assetsDir = path.join(workspace, "assets");
  const manifestsDir = path.join(assetsDir, "manifests");
  let world;
  let report;
  let durablePool = null;
  let closeDurableDatabase = null;
  let worldDatabase = null;
  try {
    await copyManifestTree(MANIFEST_SOURCE, manifestsDir);
    const manifestDigest = await digestTree(manifestsDir);
    emitPreparationProgress("manifests_ready");
    process.env.HYPERIA_DATA_DIR = workspace;
    process.env.ASSETS_DIR = assetsDir;
    const framework = await import(pathToFileURL(FRAMEWORK_PATH).href);
    emitPreparationProgress("framework_loaded");
    const {
      EventType,
      GATHERING_CONSTANTS,
      NodeStorage,
      canPlayerPerformPreparationAction,
      createServerWorld,
      getItem,
      isPlayerProcessingQuiescent,
      requestPlayerProcessingQuiescence,
      SystemClass,
    } = framework;
    world = await createServerWorld();
    emitPreparationProgress("world_ready");
    class LiveWorldDatabaseBoundary extends SystemClass {
      async getPlayerAsync() {
        return null;
      }

      async getPlayerInventoryAsync() {
        return [];
      }

      async getPlayerEquipmentAsync() {
        return [];
      }

      async getBankDataAsync() {
        return [];
      }

      async getUnrecoveredDeathsAsync() {
        return [];
      }

      async getAllActiveDeathsAsync() {
        return [];
      }

      async getDeathLockAsync() {
        return null;
      }

      async getGatheringResourceStatesAsync() {
        return [];
      }

      async getActiveProcessingFiresAsync() {
        return [];
      }

      async createPlayerSessionAsync() {}

      async getActivePlayerSessionsAsync() {
        return [];
      }

      async endPlayerSessionAsync() {}

      endPlayerSession() {}

      updateChunkPlayerCount() {}

      getInactiveChunks() {
        return [];
      }

      markChunkForReset() {}

      resetChunk() {}

      cleanupOldSessions() {
        return 0;
      }

      cleanupOldChunkActivity() {
        return 0;
      }

      getDatabaseStats() {
        return {};
      }

      async savePlayer() {}

      async savePlayerAsync() {}

      async savePlayerInventoryAsync() {}

      async savePlayerEquipmentAsync() {}

      async saveWorldChunk() {}

      async updateGroundItemsAsync() {}
    }
    class LiveWorldServerBoundary extends SystemClass {
      id = "launch-matrix-server";
      isServer = true;
      isClient = false;

      send() {}
    }
    let durableLegacyDatabase;
    if (DURABLE_DATABASE_URL) {
      const [{ DatabaseSystem }, databaseClient, { createDrizzleAdapter }] =
        await Promise.all([
          import("../src/systems/DatabaseSystem/index.ts"),
          import("../src/database/client.ts"),
          import("../src/database/adapter.ts"),
        ]);
      const initialized =
        await databaseClient.initializeDatabase(DURABLE_DATABASE_URL);
      durablePool = initialized.pool;
      closeDurableDatabase = databaseClient.closeDatabase;
      durableLegacyDatabase = createDrizzleAdapter(initialized.db);
      world.register("database", DatabaseSystem);
      world.pgPool = initialized.pool;
      world.drizzleDb = initialized.db;
    } else {
      world.register("database", LiveWorldDatabaseBoundary);
    }
    world.register("network", LiveWorldServerBoundary);
    const registeredSystems = Object.fromEntries(
      SYSTEM_NAMES.map((name) => [
        name,
        world.getSystem(name)?.constructor?.name ?? null,
      ]),
    );
    await world.init({
      assetsDir,
      storage: new NodeStorage(),
      physics: false,
      renderer: "headless",
      ...(durableLegacyDatabase ? { db: durableLegacyDatabase } : {}),
    });
    worldDatabase = world.getSystem("database");
    await waitFor(
      () => world.entities.get("station_range_spawn"),
      "production range station did not spawn",
      15_000,
    );
    const initializedSystems = Object.fromEntries(
      SYSTEM_NAMES.map((name) => {
        const system = world.getSystem(name);
        return [
          name,
          {
            constructor: system?.constructor?.name ?? null,
            idleProbe:
              typeof system?.isPlayerProcessingQuiescent === "function",
            quiescence:
              typeof system?.requestPlayerProcessingQuiescence === "function",
          },
        ];
      }),
    );
    assert(
      Object.values(initializedSystems).every(
        (system) => system.idleProbe && system.quiescence,
      ),
      "one or more live processing systems lack the quiescence contract",
      initializedSystems,
    );

    assert(
      !PREPARATION_ONLY || DURABLE_DATABASE_URL,
      "preparation-only live-world mode requires real PostgreSQL",
    );
    if (DURABLE_DATABASE_URL && !PREPARATION_ONLY) {
      await seedDurablePlayers(durablePool, [
        {
          playerId: PLAYER_ID,
          name: "Launch Matrix Agent",
          cookingLevel: 99,
          rawShrimp: false,
        },
      ]);
    }

    let player = null;
    if (!PREPARATION_ONLY) {
      player = world.entities.add({
        id: PLAYER_ID,
        type: "player",
        name: "Launch Matrix Agent",
        playerId: PLAYER_ID,
        playerName: "Launch Matrix Agent",
        position: [0, 40, 0],
        quaternion: [0, 0, 0, 1],
        isAgent: true,
        isEmbeddedAgent: true,
      });
      world.emit(EventType.PLAYER_REGISTERED, { playerId: PLAYER_ID });
      world.emit(EventType.PLAYER_JOINED, {
        playerId: PLAYER_ID,
        player,
        inventory: [{ slotIndex: 0, itemId: "logs", quantity: 1 }],
        equipment: [{ slotType: "weapon", itemId: "staff", quantity: 1 }],
        isAgent: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      installStations(world, player.position);
    }

    const events = [];
    const eventBus = world.$eventBus;
    const originalEmitEvent = eventBus.emitEvent.bind(eventBus);
    eventBus.emitEvent = (type, data, source) => {
      const eventType = String(type);
      if (OBSERVED_EVENT_TYPES.has(eventType)) {
        events.push({ type: eventType, data: structuredClone(data) });
      }
      return originalEmitEvent(type, data, source);
    };

    const inventory = world.getSystem("inventory");
    const equipment = world.getSystem("equipment");
    const skills = world.getSystem("skills");
    const banking = world.getSystem("banking");
    const coinPouch = world.getSystem("coin-pouch");
    assert(
      inventory && equipment && skills && banking && coinPouch,
      "authoritative state systems are missing",
    );
    const commitCalls = [];
    const heldReceipts = [];
    const context = {
      EventType,
      GATHERING_CONSTANTS,
      banking,
      canPlayerPerformPreparationAction,
      coinPouch,
      commitCalls,
      durableDatabase: Boolean(DURABLE_DATABASE_URL),
      equipment,
      events,
      getItem,
      heldReceipts,
      inventory,
      isPlayerProcessingQuiescent,
      pgPool: durablePool,
      player,
      requestPlayerProcessingQuiescence,
      skills,
      world,
    };
    const cases = [];
    if (!PREPARATION_ONLY) {
      assert(
        banking.getBankData(PLAYER_ID, "bank_town_0"),
        "bank lifecycle did not initialize the matrix player",
      );
      banking.getBankData(PLAYER_ID, "bank_town_0").items.push({
        id: "matrix-bank-shrimp",
        itemId: "shrimp",
        quantity: 7,
        slot: 0,
        metadata: null,
      });
      const originalCommit =
        inventory.commitProcessingActionAtomic.bind(inventory);
      inventory.commitProcessingActionAtomic = (
        playerId,
        operationId,
        input,
      ) => {
        const held = deferred();
        commitCalls.push({
          playerId,
          operationId,
          input: structuredClone(input),
        });
        heldReceipts.push(held);
        return held.promise;
      };
      try {
        world.currentTick = 10_000;
        for (let index = 0; index < CASES.length; index += 1) {
          cases.push(await runCase(context, CASES[index], index));
        }
      } finally {
        inventory.commitProcessingActionAtomic = originalCommit;
      }
    }
    if (DURABLE_DATABASE_URL) {
      await seedDurablePlayers(durablePool, [
        {
          playerId: PREPARATION_AGENT_ID,
          name: PREPARATION_AGENT_NAME,
          cookingLevel: 1,
          bankItems: [{ itemId: PREPARATION_TOOL_ID, quantity: 1 }],
        },
      ]);
    }
    emitPreparationProgress("preparation_started");
    const preparationVerticalSlice = await runPreparationVerticalSlice(context);
    emitPreparationProgress("preparation_completed");
    const populationStation = PREPARATION_ONLY
      ? { status: "skipped", reason: "preparation_only_mode" }
      : await runPopulationStationCase(context);

    report = stable({
      schemaVersion: 3,
      status: "passed",
      generatedAt: new Date().toISOString(),
      runtime: {
        bun: Bun.version,
        framework: {
          bytes: frameworkBytes.byteLength,
          modifiedAt: frameworkStat.mtime.toISOString(),
          path: path.relative(REPO_ROOT, FRAMEWORK_PATH),
          sha256: sha256(frameworkBytes),
        },
        manifests: manifestDigest,
        mode: PREPARATION_ONLY
          ? "ordinary_preparation_only"
          : "complete_matrix",
        workspacePath: workspace,
        preparationAgentId: PREPARATION_AGENT_ID,
        matrixTicksAfterFreeze: PREPARATION_ONLY ? 0 : 64,
        controlledBoundaries: PREPARATION_ONLY
          ? [
              "server-mode network lifecycle boundary (no sockets)",
              `unmodified production worker, AgentBehaviorBridge, physical bank/movement/gathering/processing${PREPARATION_FORGING_QUEST ? "/quest/forging" : ""} authorities, and real PostgreSQL custody for one ordinary-agent preparation slice`,
            ]
          : [
              "server-mode network lifecycle boundary (no sockets)",
              ...(DURABLE_DATABASE_URL
                ? [
                    "held controlled receipt response for the eight-family quiescence matrix only",
                    "unmodified production worker, AgentBehaviorBridge, physical bank/movement/gathering/processing authorities, and real PostgreSQL custody for the ordinary-agent preparation vertical slice",
                    "real PostgreSQL production DatabaseSystem and unmodified InventorySystem commit path for the 25-agent population",
                  ]
                : [
                    "in-memory database lifecycle boundary (no PostgreSQL writes)",
                    "held durable-receipt response on the production InventorySystem",
                    "immediate controlled receipt response for the 25-agent live range population",
                  ]),
            ],
        receiptSeam: PREPARATION_ONLY
          ? "none; ordinary preparation uses the unmodified production PostgreSQL commit path"
          : DURABLE_DATABASE_URL
            ? "held deterministic receipt response only for the eight-family quiescence matrix; the 25-agent population uses the unmodified production InventorySystem to commit and converge real PostgreSQL receipts"
            : "held deterministic durable-receipt response on the live InventorySystem; authoritative live inventory and money-pouch convergence applied exactly once before the production processing system consumed the receipt",
        databaseMode: DURABLE_DATABASE_URL
          ? "real_postgresql"
          : "controlled_no_write",
        registeredSystems,
        initializedSystems,
      },
      stateSurfaces: [
        "inventory",
        "equipment",
        "xp",
        "selectedSpell",
        "bank",
        "pose",
        "stationTarget",
        "ordinaryAgentPreparation",
        "gatheringMovementAndFacing",
        "gatheringAndCookingCustody",
        ...(PREPARATION_FORGING_QUEST
          ? ["questProgression", "miningSmeltingSmithingCustody"]
          : []),
        ...(!PREPARATION_ONLY
          ? ["populationMovement", "populationStationAdmission"]
          : []),
      ],
      cases,
      preparationVerticalSlice,
      populationStation,
      summary: {
        families: cases.map((entry) => entry.family),
        familyCount: cases.length,
        commitCount: commitCalls.length,
        noPostFreezeDrift: cases.every(
          (entry) =>
            stableJson(entry.snapshots.freeze) ===
            stableJson(entry.snapshots.after),
        ),
        noPostFreezeWorkingPresentation: cases.every(
          (entry) => entry.eventCounts.postFreezeWorking === 0,
        ),
        allQuiescenceRequestsAccepted: cases.every(
          (entry) => entry.quiescenceRequest.ok === true,
        ),
        preparationVerticalSlice: preparationVerticalSlice.status,
        preparationCookingActions:
          preparationVerticalSlice.cooking?.actions ?? 0,
        preparationGatheringReceipts:
          preparationVerticalSlice.gathering?.durableReceipts ?? 0,
        preparationForgingQuest:
          preparationVerticalSlice.forging?.status ?? "missing",
        preparationForgingGatheringReceipts:
          preparationVerticalSlice.forging?.gatheringReceipts ?? 0,
        preparationForgingProcessingReceipts:
          preparationVerticalSlice.forging?.processingReceipts ?? 0,
        preparationForgedWeapon:
          preparationVerticalSlice.forging?.persisted?.bronze_shortsword ?? 0,
        population: populationStation.population ?? 0,
        populationCompletions: populationStation.processing?.completions ?? 0,
        populationReceiptCount: populationStation.processing?.receiptCount ?? 0,
        populationRejections: populationStation.processing?.rejections ?? 0,
      },
    });
    if (!PREPARATION_ONLY) {
      assert(
        report.summary.familyCount === 8,
        "matrix did not cover eight families",
      );
      assert(
        report.summary.commitCount === 8,
        "matrix did not commit exactly once per family",
      );
      assert(
        report.summary.noPostFreezeDrift,
        "matrix contained post-freeze drift",
      );
    }
    assert(
      report.summary.preparationVerticalSlice === "passed" &&
        report.summary.preparationCookingActions > 0 &&
        report.summary.preparationGatheringReceipts > 0,
      "ordinary-agent preparation vertical slice was incomplete",
      report.summary,
    );
    if (PREPARATION_FORGING_QUEST) {
      assert(
        report.summary.preparationForgingQuest === "passed" &&
          report.summary.preparationForgingGatheringReceipts === 8 &&
          report.summary.preparationForgingProcessingReceipts === 7 &&
          Number(report.summary.preparationForgedWeapon) === 1,
        "ordinary-agent forging quest vertical slice was incomplete",
        report.summary,
      );
    }
    if (!PREPARATION_ONLY) {
      assert(
        report.summary.population === POPULATION_SIZE &&
          report.summary.populationCompletions === POPULATION_SIZE &&
          report.summary.populationReceiptCount === POPULATION_SIZE &&
          report.summary.populationRejections === 0,
        "population station matrix was incomplete",
        report.summary,
      );
    }
    await writePrivateReport(report);
    console.log(
      JSON.stringify({
        ...(PREPARATION_ONLY
          ? { event: "ordinary_preparation_committed" }
          : {}),
        status: report.status,
        report: REPORT_PATH,
        workspacePath: workspace,
        preparationAgentId: PREPARATION_AGENT_ID,
        frameworkSha256: report.runtime.framework.sha256,
        manifestSha256: report.runtime.manifests.sha256,
        summary: report.summary,
      }),
    );
    if (PREPARATION_ONLY && HOLD_AFTER_PREPARATION) {
      await new Promise(() => undefined);
    }
  } catch (error) {
    const failure = {
      schemaVersion: 3,
      status: "failed",
      generatedAt: new Date().toISOString(),
      error: {
        message: error instanceof Error ? error.message : String(error),
        details: error?.details ?? null,
        stack: error instanceof Error ? error.stack : null,
      },
    };
    await writePrivateReport(failure);
    throw error;
  } finally {
    if (DURABLE_DATABASE_URL) {
      await worldDatabase?.waitForPendingOperations?.().catch(() => undefined);
    }
    world?.destroy();
    await closeDurableDatabase?.().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}

await main();
