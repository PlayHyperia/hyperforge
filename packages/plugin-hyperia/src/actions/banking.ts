/**
 * Banking actions - BANK_DEPOSIT, BANK_WITHDRAW, BANK_DEPOSIT_ALL
 *
 * Autonomous-friendly banking: agents walk to bank, open session,
 * deposit/withdraw using proper server packet protocol, then close.
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { HyperiaService } from "../services/HyperiaService.js";
import type {
  BankItem,
  Entity,
  ExternalAgentBankRetainedItem,
  InventoryItem,
} from "../types.js";
import { getItemName } from "../utils/item-detection.js";
import { getItemEntry } from "../utils/world-data.js";

function normalizePosition(pos: unknown): [number, number, number] | null {
  if (Array.isArray(pos) && pos.length >= 3) {
    const position = [Number(pos[0]), Number(pos[1]), Number(pos[2])] as [
      number,
      number,
      number,
    ];
    return position.every(Number.isFinite) ? position : null;
  }
  if (pos && typeof pos === "object" && "x" in pos) {
    const p = pos as { x: unknown; y?: unknown; z?: unknown };
    const position = [Number(p.x), Number(p.y ?? 0), Number(p.z)] as [
      number,
      number,
      number,
    ];
    return position.every(Number.isFinite) ? position : null;
  }
  return null;
}

function tileDistanceBetween(
  a: [number, number, number],
  b: unknown,
): number | null {
  const target = normalizePosition(b);
  if (!target) return null;
  return Math.max(Math.abs(a[0] - target[0]), Math.abs(a[2] - target[2]));
}

function isPhysicalBank(entity: Entity): boolean {
  return (
    (entity.type || "").toLowerCase() === "bank" ||
    (entity.entityType || "").toLowerCase() === "bank"
  );
}

function findNearestBank(
  service: HyperiaService,
  playerPos: [number, number, number],
): Entity | null {
  let bestBank: Entity | null = null;
  let bestDist = Infinity;

  for (const entity of service.getNearbyEntities()) {
    if (!isPhysicalBank(entity)) continue;
    const dist = tileDistanceBetween(playerPos, entity.position);
    if (dist !== null && dist < bestDist) {
      bestDist = dist;
      bestBank = entity;
    }
  }
  return bestBank;
}

const BANK_INTERACTION_RANGE = 2;
const BANK_MOVE_POLL_MS = 200;
const BANK_MOVE_MIN_TIMEOUT_MS = 5_000;
const BANK_MOVE_MAX_TIMEOUT_MS = 30_000;

async function moveIntoBankRange(
  service: HyperiaService,
  target: Entity,
): Promise<boolean> {
  const playerPosition = normalizePosition(service.getPlayerEntity()?.position);
  const targetPosition = normalizePosition(target.position);
  if (!playerPosition || !targetPosition) return false;

  const initialDistance = tileDistanceBetween(playerPosition, targetPosition);
  if (initialDistance === null) return false;
  if (initialDistance <= BANK_INTERACTION_RANGE) return true;

  const timeoutMs = Math.min(
    BANK_MOVE_MAX_TIMEOUT_MS,
    Math.max(
      BANK_MOVE_MIN_TIMEOUT_MS,
      Math.ceil(initialDistance * 800 + 2_000),
    ),
  );
  await service.executeMove({ target: targetPosition, runMode: true });
  const deadline = Date.now() + timeoutMs;
  while (service.isConnected() && Date.now() <= deadline) {
    const currentPlayerPosition = normalizePosition(
      service.getPlayerEntity()?.position,
    );
    const currentTarget = service
      .getNearbyEntities()
      .find((entity) => entity.id === target.id && isPhysicalBank(entity));
    if (!currentTarget || !currentPlayerPosition) return false;
    const distance = tileDistanceBetween(
      currentPlayerPosition,
      currentTarget.position,
    );
    if (distance !== null && distance <= BANK_INTERACTION_RANGE) return true;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, BANK_MOVE_POLL_MS),
    );
  }
  return false;
}

function getCanonicalItemId(item: InventoryItem): string {
  return item.itemId || item.id || "";
}

function getInventoryQuantity(items: InventoryItem[], itemId: string): number {
  return items.reduce(
    (total, item) =>
      getCanonicalItemId(item) === itemId
        ? total + Math.max(0, Number(item.quantity) || 0)
        : total,
    0,
  );
}

/**
 * Derive a conservative private carry manifest from authored item metadata and
 * live state. Unknown items fail closed into retention. Combat gear, exact
 * quest inputs, switching consumables, every non-substitutable gathering tool
 * tied at the best authored priority for its skill, and one complete health
 * bar of food are never silently bulk-banked.
 */
export function buildExternalBankRetentionManifest(
  service: HyperiaService,
  items: InventoryItem[],
): ExternalAgentBankRetainedItem[] {
  const owned = new Map<string, number>();
  for (const item of items) {
    const itemId = getCanonicalItemId(item);
    const quantity = Math.max(0, Number(item.quantity) || 0);
    if (!itemId || quantity <= 0) continue;
    owned.set(itemId, (owned.get(itemId) ?? 0) + quantity);
  }
  const retained = new Map<string, number>();
  const retain = (itemId: string, quantity: number): void => {
    const available = owned.get(itemId) ?? 0;
    if (available <= 0 || quantity <= 0) return;
    retained.set(
      itemId,
      Math.min(available, Math.max(retained.get(itemId) ?? 0, quantity)),
    );
  };

  const bestTools = new Map<
    string,
    { itemIds: Set<string>; priority: number }
  >();
  for (const [itemId, quantity] of owned) {
    const definition = getItemEntry(itemId);
    if (!definition) {
      retain(itemId, quantity);
      continue;
    }
    if (definition.type === "tool") {
      if (!definition.tool) {
        retain(itemId, 1);
        continue;
      }
      const current = bestTools.get(definition.tool.skill);
      if (!current || definition.tool.priority < current.priority) {
        bestTools.set(definition.tool.skill, {
          itemIds: new Set([itemId]),
          priority: definition.tool.priority,
        });
      } else if (definition.tool.priority === current.priority) {
        current.itemIds.add(itemId);
      }
      continue;
    }
    if (
      definition.type === "weapon" ||
      definition.type === "armor" ||
      definition.type === "ammunition" ||
      definition.equipSlot !== null ||
      itemId.endsWith("_rune")
    ) {
      retain(itemId, quantity);
    }
  }
  for (const tool of bestTools.values()) {
    for (const itemId of [...tool.itemIds].sort((left, right) =>
      left.localeCompare(right),
    )) {
      retain(itemId, 1);
    }
  }

  const state = service.getGameState();
  for (const quest of state.quests) {
    if (quest.status !== "in_progress" || !quest.stageTarget) continue;
    const required =
      Number.isSafeInteger(quest.stageCount) && (quest.stageCount ?? 0) > 0
        ? quest.stageCount!
        : 1;
    retain(quest.stageTarget, required);
  }

  const foods = [...owned.entries()]
    .map(([itemId, quantity]) => ({
      itemId,
      quantity,
      healAmount: getItemEntry(itemId)?.healAmount ?? 0,
    }))
    .filter((entry) => entry.healAmount > 0)
    .sort(
      (left, right) =>
        right.healAmount - left.healAmount ||
        left.itemId.localeCompare(right.itemId),
    );
  const maxHealth = Math.max(
    0,
    Math.floor(Number(service.getPlayerEntity()?.health?.max) || 0),
  );
  let retainedHealing = foods.reduce(
    (total, food) => total + (retained.get(food.itemId) ?? 0) * food.healAmount,
    0,
  );
  for (const food of foods) {
    if (retainedHealing >= maxHealth) break;
    const alreadyRetained = retained.get(food.itemId) ?? 0;
    const available = Math.max(0, food.quantity - alreadyRetained);
    const needed = Math.ceil((maxHealth - retainedHealing) / food.healAmount);
    const additional = Math.min(available, needed);
    retain(food.itemId, alreadyRetained + additional);
    retainedHealing += additional * food.healAmount;
  }

  return [...retained]
    .map(([itemId, quantity]) => ({ itemId, quantity }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
}

function normalizeItemQuery(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findInventoryItem(
  items: InventoryItem[],
  query: string,
): InventoryItem | null {
  const normalizedQuery = normalizeItemQuery(query);
  if (!normalizedQuery) return null;
  const exact = items.find((item) => {
    const id = normalizeItemQuery(getCanonicalItemId(item));
    const name = normalizeItemQuery(getItemName(item));
    return id === normalizedQuery || name === normalizedQuery;
  });
  return (
    exact ??
    items.find((item) => {
      const id = normalizeItemQuery(getCanonicalItemId(item));
      const name = normalizeItemQuery(getItemName(item));
      return id.includes(normalizedQuery) || name.includes(normalizedQuery);
    }) ??
    null
  );
}

function findBankItem(items: BankItem[], query: string): BankItem | null {
  const normalizedQuery = normalizeItemQuery(query);
  if (!normalizedQuery) return null;
  const available = items.filter((item) => item.quantity > 0);
  const exact = available.find(
    (item) =>
      normalizeItemQuery(item.itemId) === normalizedQuery ||
      normalizeItemQuery(item.name || "") === normalizedQuery,
  );
  return (
    exact ??
    available.find(
      (item) =>
        normalizeItemQuery(item.itemId).includes(normalizedQuery) ||
        normalizeItemQuery(item.name || "").includes(normalizedQuery),
    ) ??
    null
  );
}

// ============================================================================
// BANK_DEPOSIT — deposit specific items
// ============================================================================

export const bankDepositAction: Action = {
  name: "BANK_DEPOSIT",
  similes: ["DEPOSIT", "BANK_ITEMS", "STORE"],
  description:
    "Deposit items into the bank. Walks to nearest bank if not already there. Use BANK_DEPOSIT_ALL for bulk depositing.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service?.isConnected()) return false;

    const player = service.getPlayerEntity();
    if (!player) return false;
    if (player.inCombat) return false;

    const inventoryItems = Array.isArray(player.items) ? player.items : [];
    return inventoryItems.length > 0;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) {
        return { success: false, error: new Error("Service not available") };
      }

      const player = service.getPlayerEntity();
      if (!player) {
        return { success: false, error: new Error("No player entity") };
      }

      const playerPos = normalizePosition(player.position);
      if (!playerPos) {
        return {
          success: false,
          error: new Error("Cannot determine position"),
        };
      }

      // Find nearest bank
      const bank = findNearestBank(service, playerPos);
      if (!bank) {
        await callback?.({
          text: "No bank found nearby. I need to travel to a town with a bank.",
          action: "BANK_DEPOSIT",
        });
        return { success: false, error: new Error("No bank found nearby") };
      }

      const dist = tileDistanceBetween(playerPos, bank.position);
      if (dist !== null && dist > BANK_INTERACTION_RANGE) {
        logger.info(`[BANK_DEPOSIT] Walking to bank (${dist.toFixed(1)} away)`);
        await callback?.({
          text: `Walking to the bank... (${dist.toFixed(0)} units away)`,
          action: "BANK_DEPOSIT",
        });
      }
      if (!(await moveIntoBankRange(service, bank))) {
        throw new Error("Bank was not reached");
      }

      const content = message.content.text || "";
      const currentPlayer = service.getPlayerEntity();
      const inventoryItems = Array.isArray(currentPlayer?.items)
        ? currentPlayer.items
        : [];
      const term = content
        .toLowerCase()
        .replace(/\bdeposit\b/gi, " ")
        .replace(/\d+/g, " ")
        .replace(/\b(all|my|the|into|in|bank|items?)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      const item = findInventoryItem(inventoryItems, term);
      if (!item) {
        throw new Error(
          term
            ? `No inventory item matches "${term}"`
            : "Specify an inventory item; use BANK_DEPOSIT_ALL for bulk banking",
        );
      }

      const itemId = getCanonicalItemId(item);
      const availableQuantity = getInventoryQuantity(inventoryItems, itemId);
      const quantityMatch = content.match(/(\d+)/);
      const requestedQuantity = quantityMatch
        ? Number.parseInt(quantityMatch[1], 10)
        : availableQuantity;
      if (
        !Number.isSafeInteger(requestedQuantity) ||
        requestedQuantity <= 0 ||
        requestedQuantity > availableQuantity
      ) {
        throw new Error(
          `Requested ${requestedQuantity} ${itemId}, but only ${availableQuantity} available`,
        );
      }

      if (!(await service.openBank(bank.id))) {
        throw new Error("Bank did not acknowledge an open session");
      }
      let deposited = false;
      try {
        deposited = await service.bankDeposit(itemId, requestedQuantity);
      } finally {
        await service.closeBank();
      }
      if (!deposited) {
        throw new Error(
          `Deposit of ${requestedQuantity} ${itemId} was not committed`,
        );
      }

      const responseText = `Deposited ${requestedQuantity}x ${getItemName(item)} into the bank.`;
      await callback?.({ text: responseText, action: "BANK_DEPOSIT" });
      return { success: true, text: responseText };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[BANK_DEPOSIT] Failed: ${errorMsg}`);
      await callback?.({
        text: `Failed to deposit: ${errorMsg}`,
        error: true,
      });
      return { success: false, error: error as Error };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Deposit all logs" } },
      {
        name: "agent",
        content: {
          text: "Deposited items into the bank.",
          action: "BANK_DEPOSIT",
        },
      },
    ],
  ],
};

// ============================================================================
// BANK_WITHDRAW — withdraw specific items
// ============================================================================

export const bankWithdrawAction: Action = {
  name: "BANK_WITHDRAW",
  similes: ["WITHDRAW", "TAKE_FROM_BANK"],
  description:
    "Withdraw items from the bank. Walks to nearest bank if not already there.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service?.isConnected()) return false;

    const player = service.getPlayerEntity();
    if (!player) return false;
    if (player.inCombat) return false;

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) {
        return { success: false, error: new Error("Service not available") };
      }

      const player = service.getPlayerEntity();
      if (!player) {
        return { success: false, error: new Error("No player entity") };
      }

      const playerPos = normalizePosition(player.position);
      if (!playerPos) {
        return {
          success: false,
          error: new Error("Cannot determine position"),
        };
      }

      const bank = findNearestBank(service, playerPos);
      if (!bank) {
        await callback?.({
          text: "No bank found nearby. I need to travel to a town with a bank.",
          action: "BANK_WITHDRAW",
        });
        return { success: false, error: new Error("No bank found nearby") };
      }

      const dist = tileDistanceBetween(playerPos, bank.position);
      if (dist !== null && dist > BANK_INTERACTION_RANGE) {
        logger.info(
          `[BANK_WITHDRAW] Walking to bank (${dist.toFixed(1)} away)`,
        );
        await callback?.({
          text: `Walking to the bank... (${dist.toFixed(0)} units away)`,
          action: "BANK_WITHDRAW",
        });
      }
      if (!(await moveIntoBankRange(service, bank))) {
        throw new Error("Bank was not reached");
      }

      const content = message.content.text || "";
      const itemName = content
        .toLowerCase()
        .replace(/\bwithdraw\b/gi, " ")
        .replace(/\d+/g, " ")
        .replace(/\b(from|the|bank|my)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (!itemName) {
        await callback?.({
          text: "Please specify which item to withdraw.",
          action: "BANK_WITHDRAW",
        });
        return {
          success: false,
          error: new Error("No item specified for withdrawal"),
        };
      }

      const quantityMatch = content.match(/(\d+)/);
      const requestedQuantity = quantityMatch
        ? Number.parseInt(quantityMatch[1], 10)
        : 1;
      if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity <= 0) {
        throw new Error("Withdrawal quantity must be a positive integer");
      }

      if (!(await service.openBank(bank.id))) {
        throw new Error("Bank did not acknowledge an open session");
      }

      let bankItem: BankItem | null = null;
      let quantity = 0;
      let withdrawn = false;
      let inventoryBefore = 0;
      try {
        bankItem = findBankItem(service.getBankItems(), itemName);
        if (!bankItem) {
          throw new Error(`No bank item matches "${itemName}"`);
        }
        if (bankItem.itemId === "coins") {
          throw new Error(
            "Coin-pouch withdrawals require the dedicated coin action",
          );
        }
        quantity = Math.min(requestedQuantity, bankItem.quantity);
        const inventoryBeforeItems = service.getPlayerEntity()?.items;
        inventoryBefore = getInventoryQuantity(
          Array.isArray(inventoryBeforeItems) ? inventoryBeforeItems : [],
          bankItem.itemId,
        );
        withdrawn = await service.bankWithdraw(bankItem.itemId, quantity);
      } finally {
        await service.closeBank();
      }
      if (!bankItem || !withdrawn) {
        throw new Error(`Withdrawal of ${itemName} was not committed`);
      }

      const currentItems = service.getPlayerEntity()?.items;
      const actualQuantity =
        getInventoryQuantity(
          Array.isArray(currentItems) ? currentItems : [],
          bankItem.itemId,
        ) - inventoryBefore;
      if (actualQuantity <= 0) {
        throw new Error(`Withdrawal of ${bankItem.itemId} was not observed`);
      }

      const amountLabel = actualQuantity > 1 ? `${actualQuantity}x ` : "";
      const responseText = `Withdrew ${amountLabel}${bankItem.name || bankItem.itemId} from the bank.`;
      await callback?.({ text: responseText, action: "BANK_WITHDRAW" });
      return { success: true, text: responseText };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[BANK_WITHDRAW] Failed: ${errorMsg}`);
      await callback?.({
        text: `Failed to withdraw: ${errorMsg}`,
        error: true,
      });
      return { success: false, error: error as Error };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Withdraw axe" } },
      {
        name: "agent",
        content: {
          text: "Withdrew axe from the bank.",
          action: "BANK_WITHDRAW",
        },
      },
    ],
  ],
};

// ============================================================================
// BANK_DEPOSIT_ALL — autonomous bulk banking
// ============================================================================

export const bankDepositAllAction: Action = {
  name: "BANK_DEPOSIT_ALL",
  similes: ["BANK_ALL", "DUMP_INVENTORY", "BANK_EVERYTHING"],
  description:
    "Atomically deposit inventory surplus while retaining manifest-authored combat gear, exact quest inputs, switching consumables, one best gathering tool per skill, and a full health-bar food reserve.",

  validate: async (runtime: IAgentRuntime) => {
    const service = runtime.getService<HyperiaService>("hyperiaService");
    if (!service?.isConnected()) return false;

    const player = service.getPlayerEntity();
    if (!player) return false;
    if (player.inCombat) return false;

    const inventoryItems = Array.isArray(player.items) ? player.items : [];
    const retained = buildExternalBankRetentionManifest(
      service,
      inventoryItems,
    ).reduce((total, item) => total + item.quantity, 0);
    const owned = inventoryItems.reduce(
      (total, item) => total + Math.max(0, Number(item.quantity) || 0),
      0,
    );
    return owned > retained;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<HyperiaService>("hyperiaService");
      if (!service) {
        return { success: false, error: new Error("Service not available") };
      }

      const player = service.getPlayerEntity();
      if (!player) {
        return { success: false, error: new Error("No player entity") };
      }

      const playerPos = normalizePosition(player.position);
      if (!playerPos) {
        return {
          success: false,
          error: new Error("Cannot determine position"),
        };
      }

      const bank = findNearestBank(service, playerPos);
      if (!bank) {
        await callback?.({
          text: "No bank found nearby. I need to travel to a town with a bank first.",
          action: "BANK_DEPOSIT_ALL",
        });
        return { success: false, error: new Error("No bank found nearby") };
      }

      const dist = tileDistanceBetween(playerPos, bank.position);
      if (dist !== null && dist > BANK_INTERACTION_RANGE) {
        logger.info(
          `[BANK_DEPOSIT_ALL] Walking to bank (${dist.toFixed(1)} away)`,
        );
        await callback?.({
          text: `Walking to the bank to deposit items... (${dist.toFixed(0)} units away)`,
          action: "BANK_DEPOSIT_ALL",
        });
      }
      if (!(await moveIntoBankRange(service, bank))) {
        throw new Error("Bank was not reached");
      }

      const currentPlayer = service.getPlayerEntity();
      const inventoryItems = Array.isArray(currentPlayer?.items)
        ? currentPlayer.items
        : [];
      const retainedItems = buildExternalBankRetentionManifest(
        service,
        inventoryItems,
      );
      const retainedById = new Map(
        retainedItems.map((item) => [item.itemId, item.quantity]),
      );
      const groupedBankableItems = new Map<
        string,
        { quantity: number; name: string }
      >();
      for (const item of inventoryItems) {
        const itemId = getCanonicalItemId(item);
        const quantity = Math.max(0, Number(item.quantity) || 0);
        if (!itemId || quantity <= 0) continue;
        const current = groupedBankableItems.get(itemId);
        groupedBankableItems.set(itemId, {
          quantity: (current?.quantity ?? 0) + quantity,
          name: current?.name ?? getItemName(item),
        });
      }
      for (const [itemId, retainedQuantity] of retainedById) {
        const item = groupedBankableItems.get(itemId);
        if (!item) continue;
        const quantity = item.quantity - retainedQuantity;
        if (quantity > 0) item.quantity = quantity;
        else groupedBankableItems.delete(itemId);
      }
      if (groupedBankableItems.size === 0) {
        throw new Error(
          "No non-essential inventory items are available to bank",
        );
      }

      logger.info(
        `[BANK_DEPOSIT_ALL] At bank. Atomically depositing ${groupedBankableItems.size} item types, retaining ${retainedItems.length} exact item types`,
      );

      if (!(await service.openBank(bank.id))) {
        throw new Error("Bank did not acknowledge an open session");
      }

      const depositedTypes = groupedBankableItems.size;
      const depositedQuantity = [...groupedBankableItems.values()].reduce(
        (total, item) => total + item.quantity,
        0,
      );
      let committed = false;
      try {
        committed = await service.bankDepositAll(retainedItems);
      } finally {
        await service.closeBank();
      }

      if (!committed) {
        const failText =
          "Atomic surplus banking did not return a committed receipt";
        logger.warn(`[BANK_DEPOSIT_ALL] ${failText}`);
        await callback?.({ text: failText, action: "BANK_DEPOSIT_ALL" });
        return { success: false, error: new Error(failText) };
      }

      const responseText = `Banked ${depositedQuantity} items across ${depositedTypes} item types. Retained ${retainedItems.length} exact working item types.`;
      await callback?.({ text: responseText, action: "BANK_DEPOSIT_ALL" });
      logger.info(`[BANK_DEPOSIT_ALL] ${responseText}`);

      return {
        success: true,
        text: responseText,
        data: {
          action: "BANK_DEPOSIT_ALL",
          deposited: depositedQuantity,
          keptEssentials: retainedItems.length,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[BANK_DEPOSIT_ALL] Failed: ${errorMsg}`);
      await callback?.({
        text: `Failed to bank items: ${errorMsg}`,
        error: true,
      });
      return { success: false, error: error as Error };
    }
  },

  examples: [
    [
      {
        name: "system",
        content: { text: "Inventory full with 28 shrimp, near a bank" },
      },
      {
        name: "agent",
        content: {
          text: "Banked surplus in one transaction and retained the exact working loadout.",
          action: "BANK_DEPOSIT_ALL",
        },
      },
    ],
  ],
};

export const bankingActions = [
  bankDepositAction,
  bankWithdrawAction,
  bankDepositAllAction,
];
