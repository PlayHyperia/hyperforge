import type { ActionContext, ActionDefinition, World } from "../../../types";
import { EventType } from "../../../types/events";
import { generateGroundItemDropOperationId } from "../../../utils/game/GroundItemSourceIdentity";
import { SystemBase } from "../infrastructure/SystemBase";

/**
 * Base ActionRegistry class for managing action definitions
 */
class BaseActionRegistry {
  private actions = new Map<string, ActionDefinition>();

  register(action: ActionDefinition): void {
    this.actions.set(action.name, action);
  }

  unregister(name: string): boolean {
    return this.actions.delete(name);
  }

  get(name: string): ActionDefinition | undefined {
    return this.actions.get(name);
  }

  getAll(): ActionDefinition[] {
    return Array.from(this.actions.values());
  }

  getAvailable(context: ActionContext): ActionDefinition[] {
    return this.getAll().filter((action) => {
      if (!action.validate) return true;
      return action.validate(context);
    });
  }

  async execute(
    name: string,
    context: ActionContext,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const action = this.actions.get(name);
    if (!action) {
      throw new Error(`Action not found: ${name}`);
    }

    if (action.validate && !action.validate(context)) {
      throw new Error(`Action validation failed: ${name}`);
    }

    return await action.execute(context, params);
  }
}

/**
 * Action Registry System
 *
 * This system creates and manages the world's actionRegistry,
 * exposing all actions for agent discovery and execution.
 */
export class ActionRegistry extends SystemBase {
  private actionRegistryInstance: BaseActionRegistry;

  constructor(world: World) {
    super(world, {
      name: "action-registry",
      dependencies: {
        required: [], // Action registry can work independently
        optional: [
          "combat",
          "inventory",
          "skills",
          "banking",
          "store",
          "movement",
        ], // Better with all game systems
      },
      autoCleanup: true,
    });
    this.actionRegistryInstance = new BaseActionRegistry();

    // Attach to world for discovery with compatible interface
    world.actionRegistry = {
      getAll: () =>
        this.actionRegistryInstance.getAll().map((action) => ({
          name: action.name,
          description: action.description,
          parameters: action.parameters,
          validate: action.validate,
          execute: action.execute,
        })),
      getAvailable: (context?: Partial<ActionContext>) => {
        const resolved: ActionContext = {
          world: this.world,
          playerId: context?.playerId,
          entity: context?.entity,
        };
        return this.actionRegistryInstance
          .getAvailable(resolved)
          .map((action) => ({
            name: action.name,
            description: action.description,
            parameters: action.parameters,
            validate: action.validate,
            execute: action.execute,
          }));
      },
      execute: (
        name: string,
        context: Partial<ActionContext> | undefined,
        params: Record<string, unknown>,
      ) => {
        const resolved: ActionContext = {
          world: this.world,
          playerId: context?.playerId,
          entity: context?.entity,
        };
        return this.actionRegistryInstance.execute(name, resolved, params);
      },
    };
  }

  async init(): Promise<void> {
    // Register all actions
    this.registerCombatActions();
    this.registerInventoryActions();
    this.registerSkillActions();
    this.registerBankingActions();
    this.registerStoreActions();
    this.registerMovementActions();

    this.logger.info(
      `Registered ${this.actionRegistryInstance.getAll().length} actions`,
    );
  }

  private registerCombatActions(): void {
    this.actionRegistryInstance.register({
      name: "attack",
      description: "Attack a target mob or player",
      parameters: [
        {
          name: "targetId",
          type: "string",
          required: true,
          description: "ID of the target to attack",
        },
      ],
      validate: (_context: ActionContext): boolean => {
        // Check if player is in combat range, has weapon, etc.
        return true;
      },
      execute: async (
        context: ActionContext,
        params: Record<string, unknown>,
      ) => {
        const playerId = context.playerId || context.world.network.id;
        this.emitTypedEvent(EventType.COMBAT_START_ATTACK, {
          attackerId: playerId,
          targetId: params.targetId as string,
        });
        return {
          success: true,
          message: `Started attacking ${params.targetId}`,
        };
      },
    });

    this.actionRegistryInstance.register({
      name: "stop_attack",
      description: "Stop current combat",
      parameters: [],
      execute: async (
        context: ActionContext,
        _params: Record<string, unknown>,
      ) => {
        const playerId = context.playerId || context.world.network.id;
        this.emitTypedEvent(EventType.COMBAT_STOP_ATTACK, {
          attackerId: playerId,
        });
        return { success: true, message: "Stopped attacking" };
      },
    });
  }

  private registerInventoryActions(): void {
    this.actionRegistryInstance.register({
      name: "use_item",
      description: "Use an item from inventory",
      parameters: [
        {
          name: "itemId",
          type: "string",
          required: true,
          description: "ID of the item to use",
        },
        {
          name: "slot",
          type: "number",
          required: true,
          description: "Inventory slot number",
        },
      ],
      execute: async (
        context: ActionContext,
        params: Record<string, unknown>,
      ) => {
        const playerId = context.playerId || context.world.network.id;
        const slot = params.slot as number;
        if (slot < 0) {
          return { success: false, message: "Invalid slot number provided" };
        }
        this.emitTypedEvent(EventType.INVENTORY_USE, {
          playerId,
          itemId: params.itemId as string,
          slot,
        });
        return { success: true, message: `Using item ${params.itemId}` };
      },
    });

    this.actionRegistryInstance.register({
      name: "drop_item",
      description: "Drop an item from inventory",
      parameters: [
        {
          name: "itemId",
          type: "string",
          required: true,
          description: "ID of the item to drop",
        },
        {
          name: "quantity",
          type: "number",
          required: false,
          description: "Amount to drop",
        },
        {
          name: "operationId",
          type: "string",
          required: false,
          description: "Stable retry identity for this exact drop intent",
        },
      ],
      execute: async (
        context: ActionContext,
        params: Record<string, unknown>,
      ) => {
        const playerId = context.playerId || context.world.network.id;
        const itemId = params.itemId;
        const quantity = params.quantity === undefined ? 1 : params.quantity;
        if (!playerId) {
          return { success: false, message: "Player identity unavailable" };
        }
        if (typeof itemId !== "string" || typeof quantity !== "number") {
          return { success: false, message: "Invalid item-drop request" };
        }
        const inventorySystem = context.world.getSystem("inventory") as
          | {
              dropOwnedItemAtomic?: (
                requestedPlayerId: string,
                operationId: string,
                requestedItemId: string,
                requestedQuantity: number,
              ) => Promise<{
                ok: boolean;
                committed: boolean | "unknown";
                reason?: string;
              }>;
            }
          | undefined;
        if (!context.world.isServer || !inventorySystem?.dropOwnedItemAtomic) {
          return {
            success: false,
            message: "Authoritative item-drop service unavailable",
          };
        }
        const suppliedOperationId = params.operationId;
        if (
          suppliedOperationId !== undefined &&
          typeof suppliedOperationId !== "string"
        ) {
          return {
            success: false,
            message: "Invalid item-drop operation identity",
          };
        }
        let operationId = suppliedOperationId?.trim() ?? "";
        try {
          if (!operationId) operationId = generateGroundItemDropOperationId();
        } catch {
          return {
            success: false,
            message: "Secure item-drop identity unavailable",
          };
        }
        const result = await inventorySystem.dropOwnedItemAtomic(
          playerId,
          operationId,
          itemId,
          quantity,
        );
        return result.ok
          ? {
              success: true,
              committed: true,
              operationId,
              message: `Dropped item ${itemId}`,
            }
          : {
              success: false,
              committed: result.committed,
              operationId,
              message: `Item drop rejected: ${result.reason ?? "unknown"}`,
            };
      },
    });

    this.actionRegistryInstance.register({
      name: "equip_item",
      description: "Equip an item",
      parameters: [
        {
          name: "itemId",
          type: "string",
          required: true,
          description: "ID of the item to equip",
        },
        {
          name: "slot",
          type: "string",
          required: false,
          description: "Equipment slot (auto-detect if not provided)",
        },
      ],
      execute: async (
        context: ActionContext,
        params: Record<string, unknown>,
      ) => {
        const playerId = context.playerId || context.world.network.id;
        this.emitTypedEvent(EventType.EQUIPMENT_TRY_EQUIP, {
          playerId,
          itemId: params.itemId as string,
          slot: params.slot as string | undefined,
        });
        return { success: true, message: `Equipping item ${params.itemId}` };
      },
    });

    this.actionRegistryInstance.register({
      name: "pickup_item",
      description: "Pick up an item from the ground",
      parameters: [
        {
          name: "itemId",
          type: "string",
          required: true,
          description: "ID of the ground item to pick up",
        },
      ],
      execute: async (
        context: ActionContext,
        params: Record<string, unknown>,
      ) => {
        const playerId = context.playerId || context.world.network.id;
        this.emitTypedEvent(EventType.ITEM_PICKUP_REQUEST, {
          playerId,
          itemId: params.itemId as string,
        });
        return { success: true, message: `Picking up item ${params.itemId}` };
      },
    });
  }

  private registerSkillActions(): void {
    this.actionRegistryInstance.register({
      name: "start_gathering",
      description: "Start gathering a resource",
      parameters: [
        {
          name: "resourceId",
          type: "string",
          required: true,
          description: "ID of the resource to gather",
        },
      ],
      execute: async (
        context: ActionContext,
        params: Record<string, unknown>,
      ) => {
        const playerId = context.playerId || context.world.network.id;
        const player = context.world.entities.player;
        this.emitTypedEvent(EventType.RESOURCE_GATHER, {
          playerId,
          resourceId: params.resourceId as string,
          playerPosition: player?.position,
        });
        return {
          success: true,
          message: `Started gathering ${params.resourceId}`,
        };
      },
    });

    this.actionRegistryInstance.register({
      name: "stop_gathering",
      description: "Stop current gathering action",
      parameters: [],
      execute: async (
        context: ActionContext,
        _params: Record<string, unknown>,
      ) => {
        const playerId = context.playerId || context.world.network.id;
        this.emitTypedEvent(EventType.RESOURCE_GATHERING_STOPPED, { playerId });
        return { success: true, message: "Stopped gathering" };
      },
    });
  }

  private registerBankingActions(): void {
    this.actionRegistryInstance.register({
      name: "open_bank",
      description: "Open a bank interface",
      parameters: [
        {
          name: "bankId",
          type: "string",
          required: true,
          description: "ID of the bank to open",
        },
      ],
      execute: async (
        context: ActionContext,
        params: Record<string, unknown>,
      ) => {
        const playerId = context.playerId || context.world.network.id;
        const player = context.world.entities.player;
        this.emitTypedEvent(EventType.BANK_OPEN, {
          playerId,
          bankId: params.bankId as string,
          playerPosition: player?.position,
        });
        return { success: true, message: `Opening bank ${params.bankId}` };
      },
    });

    this.actionRegistryInstance.register({
      name: "deposit_item",
      description: "Deposit an item into the bank",
      parameters: [
        {
          name: "bankId",
          type: "string",
          required: true,
          description: "ID of the bank",
        },
        {
          name: "itemId",
          type: "string",
          required: true,
          description: "ID of the item to deposit",
        },
        {
          name: "quantity",
          type: "number",
          required: false,
          description: "Amount to deposit",
        },
      ],
      execute: async (
        context: ActionContext,
        params: Record<string, unknown>,
      ) => {
        const playerId = context.playerId || context.world.network.id;
        this.emitTypedEvent(EventType.BANK_DEPOSIT, {
          playerId,
          bankId: params.bankId as string,
          itemId: params.itemId as string,
          quantity: (params.quantity as number) || 1,
        });
        return {
          success: true,
          message: `Deposited ${(params.quantity as number) || 1} ${params.itemId}`,
        };
      },
    });
  }

  private registerStoreActions(): void {
    this.actionRegistryInstance.register({
      name: "open_store",
      description: "Open a store interface",
      parameters: [
        {
          name: "storeId",
          type: "string",
          required: true,
          description: "ID of the store to open",
        },
      ],
      execute: async (
        context: ActionContext,
        params: Record<string, unknown>,
      ) => {
        const playerId = context.playerId || context.world.network.id;
        const player = context.world.entities.player;
        this.emitTypedEvent(EventType.STORE_OPEN, {
          playerId,
          storeId: params.storeId as string,
          playerPosition: player?.position,
        });
        return { success: true, message: `Opening store ${params.storeId}` };
      },
    });

    // NOTE: buy_item and sell_item actions have been removed.
    // Store transactions must go through the secure server handler
    // (packages/server/src/systems/ServerNetwork/handlers/store.ts)
    // via network.send("storeBuy"/"storeSell") to ensure proper
    // database transactions, input validation, and rate limiting.
  }

  private registerMovementActions(): void {
    this.actionRegistryInstance.register({
      name: "move_to",
      description: "Move to a specific location",
      parameters: [
        {
          name: "x",
          type: "number",
          required: true,
          description: "X coordinate",
        },
        {
          name: "y",
          type: "number",
          required: false,
          description: "Y coordinate",
        },
        {
          name: "z",
          type: "number",
          required: true,
          description: "Z coordinate",
        },
      ],
      execute: async (
        context: ActionContext,
        params: Record<string, unknown>,
      ) => {
        const playerId = context.playerId || context.world.network.id;
        this.emitTypedEvent(EventType.MOVEMENT_CLICK_TO_MOVE, {
          playerId,
          targetPosition: {
            x: params.x as number,
            y: (params.y as number) || 0,
            z: params.z as number,
          },
        });
        return {
          success: true,
          message: `Moving to (${params.x}, ${params.z})`,
        };
      },
    });

    this.actionRegistryInstance.register({
      name: "stop_moving",
      description: "Stop current movement",
      parameters: [],
      execute: async (
        context: ActionContext,
        _params: Record<string, unknown>,
      ) => {
        const playerId = context.playerId || context.world.network.id;
        this.emitTypedEvent(EventType.MOVEMENT_STOP, { playerId });
        return { success: true, message: "Stopped moving" };
      },
    });
  }

  /**
   * Get action registry for external access
   */
  getActionRegistry(): BaseActionRegistry {
    return this.actionRegistryInstance;
  }

  /**
   * Cleanup when system is destroyed
   */
  destroy(): void {
    // Clear all registered actions by creating a new ActionRegistry
    // Get all action names and unregister them
    const allActions = this.actionRegistryInstance.getAll();
    for (const action of allActions) {
      this.actionRegistryInstance.unregister(action.name);
    }

    // Clear from world
    this.world.actionRegistry = undefined;

    // Call parent cleanup
    super.destroy();
  }
}

// Export the base ActionRegistry for testing and other uses
export { BaseActionRegistry };
