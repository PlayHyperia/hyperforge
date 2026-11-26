/**
 * Inventory Interaction System
 *
 * Handles both:
 * - Drag-and-drop for inventory/equipment management
 * - Item right-click context menus (Wear, Drop, Eat, Use, etc.)
 * Provides complete classic fantasy MMORPG-style inventory interactions.
 */

import {
  DragData,
  DropTarget,
  ItemType,
  Item,
  EquipmentSlotName,
  ItemAction,
  ItemContextMenu,
} from "../../../types/core/core";
import { ItemRarity } from "../../../types/entities";
import { dataManager } from "../../../data/DataManager";

// Re-export for backward compatibility
export type { DragData, DropTarget };

import { EventType } from "../../../types/events";
import type { World } from "../../../types/index";
import { SystemBase } from "../infrastructure/SystemBase";
import { Logger } from "../../../utils/Logger";
import { processingDataProvider } from "../../../data/ProcessingDataProvider";
import { getTargetValidator } from "./TargetValidator";
import { MESSAGE_TYPES } from "../../client/interaction/constants";
import { INPUT_LIMITS } from "../../../constants/interaction";
import type { ClientNetwork } from "../../client/ClientNetwork";

/**
 * Create a minimal Item with all required properties
 */
function createMinimalItem(
  id: string,
  name: string,
  type: ItemType = ItemType.MISC,
): Item {
  return {
    id,
    name,
    type,
    quantity: 1,
    stackable: false,
    maxStackSize: 1,
    value: 0,
    weight: 1,
    equipSlot: null,
    weaponType: null,
    equipable: false,
    attackType: null,
    description: `A ${name}`,
    examine: `It's a ${name}.`,
    tradeable: true,
    rarity: ItemRarity.COMMON,
    modelPath: "",
    iconPath: "",
    healAmount: 0,
    bonuses: {},
    requirements: {
      level: 1,
      skills: {},
    },
  };
}

export class InventoryInteractionSystem extends SystemBase {
  // Drag-and-drop state
  private currentDrag?: DragData;
  private dropTargets: Map<string, DropTarget> = new Map();
  private dragPreview?: HTMLElement;
  private isDragging: boolean = false;
  private playerEquipment = new Map<string, Record<string, Item>>();

  // Context menu state (merged from ItemActionSystem)
  private contextMenus: Map<string, ItemContextMenu> = new Map();
  private itemActions: Map<string, ItemAction[]> = new Map();

  // Event listener cleanup - AbortController per element for proper cleanup
  private elementAbortControllers: Map<HTMLElement, AbortController> =
    new Map();

  /** Typed accessor for ClientNetwork (this system is client-only). */
  private get clientNetwork(): ClientNetwork | null {
    return (this.world.network as ClientNetwork) ?? null;
  }

  constructor(world: World) {
    super(world, {
      name: "inventory-interaction",
      dependencies: {
        required: [],
        optional: ["inventory", "equipment", "ui"],
      },
      autoCleanup: true,
    });
    this.registerDefaultActions();
  }

  async init(): Promise<void> {
    // Listen for UI events via event bus
    this.subscribe(
      EventType.UI_OPEN_MENU,
      (data: {
        playerId: string;
        inventoryElement: HTMLElement;
        equipmentElement?: HTMLElement;
      }) => this.setupInventoryInteractions(data),
    );
    this.subscribe(EventType.UI_CLOSE_MENU, () => this.cleanupInteractions());

    // Listen to equipment changes for reactive patterns
    this.subscribe<{
      playerId: string;
      slot: EquipmentSlotName;
      itemId: string | null;
    }>(EventType.PLAYER_EQUIPMENT_CHANGED, (data) => {
      if (!this.playerEquipment.has(data.playerId)) {
        this.playerEquipment.set(data.playerId, {});
      }
      const equipment = this.playerEquipment.get(data.playerId)!;
      if (data.itemId) {
        equipment[data.slot] = createMinimalItem(
          data.itemId,
          data.itemId,
          ItemType.MISC,
        );
      } else {
        delete equipment[data.slot];
      }
    });

    // Listen for drag/drop events
    this.subscribe(EventType.UI_DRAG_DROP, (data: unknown) =>
      this.handleDragStart(data),
    );
    this.subscribe(EventType.UI_DRAG_DROP, (data: unknown) =>
      this.handleDragEnd(data),
    );
    this.subscribe(EventType.UI_DRAG_DROP, (data: unknown) =>
      this.handleDrop(data),
    );

    // Listen for player events
    this.subscribe(EventType.PLAYER_JOINED, (data: { playerId: string }) =>
      this.handlePlayerJoin(data),
    );
    this.subscribe(EventType.PLAYER_LEFT, (data: { playerId: string }) =>
      this.handlePlayerLeave(data),
    );
    this.subscribe(EventType.PLAYER_UNREGISTERED, (data: { id: string }) => {
      this.playerEquipment.delete(data.id);
    });

    // Item action system events (merged from ItemActionSystem)
    this.subscribe<{
      playerId: string;
      itemId: string;
      slot: number;
      position: { x: number; y: number };
    }>(EventType.ITEM_RIGHT_CLICK, (data) => this.handleItemRightClick(data));
    this.subscribe<{
      playerId: string;
      actionId: string;
      itemId: string;
      slot: number;
    }>(EventType.ITEM_ACTION_SELECTED, (data) =>
      this.handleActionSelected(data),
    );
    this.subscribe<{
      corpseId: string;
      playerId: string;
      lootItems?: Array<{ itemId: string; quantity: number }>;
      position: { x: number; y: number; z: number };
    }>(EventType.CORPSE_CLICK, (data) => this.handleCorpseClick(data));

    // Listen for targeting mode selection (player clicked a valid target)
    this.subscribe<{
      playerId: string;
      sourceItemId: string;
      sourceSlot: number;
      targetId: string;
      targetType: "inventory_item" | "world_entity";
      targetSlot?: number;
    }>(EventType.TARGETING_SELECT, (data) => {
      this.handleTargetSelected(
        data.playerId,
        data.sourceItemId,
        data.sourceSlot,
        data.targetId,
        data.targetType,
        data.targetSlot,
      );
    });
  }

  start(): void {}

  /**
   * Create a complete Item from partial data
   */
  private createCompleteItem(item: Partial<Item>): Item {
    return {
      id: item.id || "",
      name: item.name || item.id || "",
      type: item.type || ItemType.MISC,
      quantity: item.quantity || 1,
      stackable: item.stackable || false,
      value: item.value || 0,
      maxStackSize: item.maxStackSize || 1,
      weight: item.weight || 1,
      equipSlot: item.equipSlot || null,
      weaponType: item.weaponType || null,
      equipable: item.equipable || false,
      attackType: item.attackType || null,
      description: item.description || "Item",
      examine: item.examine || "",
      tradeable: item.tradeable !== false,
      rarity: item.rarity || ItemRarity.COMMON,
      modelPath: item.modelPath || "",
      iconPath: item.iconPath || "",
      healAmount: item.healAmount || 0,
      bonuses: item.bonuses || {
        attack: 0,
        defense: 0,
        ranged: 0,
        strength: 0,
      },
      requirements: item.requirements || { level: 1, skills: {} },
    };
  }

  /**
   * Setup drag and drop interactions for inventory UI
   */
  private setupInventoryInteractions(event: {
    playerId: string;
    inventoryElement: HTMLElement;
    equipmentElement?: HTMLElement;
  }): void {
    if (event.inventoryElement) {
      this.setupInventorySlots(event.playerId, event.inventoryElement);
    }

    if (event.equipmentElement) {
      this.setupEquipmentSlots(event.playerId, event.equipmentElement);
    }
  }

  /**
   * Setup drag interactions for inventory slots
   */
  private setupInventorySlots(
    playerId: string,
    inventoryElement: HTMLElement,
  ): void {
    const inventorySlots = inventoryElement.querySelectorAll(
      "[data-inventory-slot]",
    );

    inventorySlots.forEach((slot, index) => {
      const slotElement = slot as HTMLElement;
      const slotIndex = parseInt(
        slotElement.dataset.inventorySlot || index.toString(),
      );

      // Make slots draggable
      this.makeSlotDraggable(playerId, slotElement, "inventory", slotIndex);

      // Register as drop target
      this.registerDropTarget(`inventory_${playerId}_${slotIndex}`, {
        type: "inventory",
        slot: slotIndex,
        element: slotElement,
        accepts: ["weapon", "armor", "food", "tool", "resource", "ammunition"],
      });
    });
  }

  /**
   * Setup drag interactions for equipment slots
   */
  private setupEquipmentSlots(
    playerId: string,
    equipmentElement: HTMLElement,
  ): void {
    const equipmentSlots = equipmentElement.querySelectorAll(
      "[data-equipment-slot]",
    );

    equipmentSlots.forEach((slot) => {
      const slotElement = slot as HTMLElement;
      const slotType = slotElement.dataset.equipmentSlot || "";

      // Make equipment slots draggable (for unequipping)
      this.makeSlotDraggable(playerId, slotElement, "equipment", slotType);

      // Register as drop target with type restrictions
      const acceptedTypes = this.getAcceptedTypesForEquipmentSlot(slotType);
      this.registerDropTarget(`equipment_${playerId}_${slotType}`, {
        type: "equipment",
        slot: slotType,
        element: slotElement,
        accepts: acceptedTypes,
      });
    });
  }

  /**
   * Make a slot draggable
   */
  private makeSlotDraggable(
    playerId: string,
    element: HTMLElement,
    sourceType: "inventory",
    slot: number,
  ): void;
  private makeSlotDraggable(
    playerId: string,
    element: HTMLElement,
    sourceType: "equipment",
    slot: string,
  ): void;
  private makeSlotDraggable(
    playerId: string,
    element: HTMLElement,
    sourceType: "inventory" | "equipment",
    slot: number | string,
  ): void {
    element.draggable = true;

    // Create AbortController for this element's listeners
    const controller = new AbortController();
    this.elementAbortControllers.set(element, controller);
    const { signal } = controller;

    element.addEventListener(
      "dragstart",
      (_event) => {
        this.handleDragStartEvent(
          _event as DragEvent,
          playerId,
          sourceType,
          slot,
        );
      },
      { signal },
    );

    element.addEventListener(
      "dragend",
      (_event) => {
        this.handleDragEndEvent(_event);
      },
      { signal },
    );

    // Also support touch interactions for mobile
    let touchStart: { x: number; y: number } | null = null;

    element.addEventListener(
      "touchstart",
      (event) => {
        const touch = (event as TouchEvent).touches[0];
        touchStart = { x: touch.clientX, y: touch.clientY };

        // Prevent scrolling during drag
        event.preventDefault();
      },
      { signal },
    );

    element.addEventListener(
      "touchmove",
      (event) => {
        if (!touchStart) return;

        const touch = (event as TouchEvent).touches[0];
        const deltaX = Math.abs(touch.clientX - touchStart.x);
        const deltaY = Math.abs(touch.clientY - touchStart.y);

        // If moved enough, start drag
        if (deltaX > 10 || deltaY > 10) {
          this.handleTouchDragStart(
            event as TouchEvent,
            playerId,
            sourceType,
            slot,
          );
          touchStart = null;
        }

        event.preventDefault();
      },
      { signal },
    );

    element.addEventListener(
      "touchend",
      () => {
        if (this.isDragging) {
          this.handleTouchDragEnd();
        }
        touchStart = null;
      },
      { signal },
    );
  }

  /**
   * Register a drop target
   */
  private registerDropTarget(id: string, target: DropTarget): void {
    this.dropTargets.set(id, target);

    // Get or create AbortController for this element
    let controller = this.elementAbortControllers.get(target.element);
    if (!controller) {
      controller = new AbortController();
      this.elementAbortControllers.set(target.element, controller);
    }
    const { signal } = controller;

    target.element.addEventListener(
      "dragover",
      (event) => {
        this.handleDragOver(event as DragEvent, target);
      },
      { signal },
    );

    target.element.addEventListener(
      "drop",
      (event) => {
        this.handleDropEvent(event as DragEvent, target);
      },
      { signal },
    );

    // Add visual feedback classes
    target.element.classList.add("drop-target");
  }

  /**
   * Handle drag start from HTML5 drag API
   */
  private handleDragStartEvent(
    event: DragEvent,
    playerId: string,
    sourceType: "inventory" | "equipment",
    slot: number | string,
  ): void {
    const itemData = this.getItemInSlot(playerId, sourceType, slot);
    if (!itemData) {
      event.preventDefault();
      return;
    }

    // Strong type assumption - sourceType determines slot type
    // inventory = number, equipment = string
    const slotNumber =
      sourceType === "inventory"
        ? (slot as number)
        : parseInt(slot as string, 10) || 0;

    const dragData: DragData = {
      sourceType: sourceType,
      sourceSlot: slotNumber,
      itemId: itemData.id,
      itemData: itemData,
      dragElement: event.target as HTMLElement,
      originalPosition: { x: event.clientX, y: event.clientY },
    };

    this.startDrag(dragData);

    // Set drag data for HTML5 API
    if (event.dataTransfer) {
      event.dataTransfer.setData(
        "application/json",
        JSON.stringify({
          sourceType: sourceType,
          sourceSlot: slot,
          itemId: itemData.id,
        }),
      );
      event.dataTransfer.effectAllowed = "move";
    }

    // Create drag preview
    this.createDragPreview(itemData, event.clientX, event.clientY);
  }

  /**
   * Handle touch-based drag start
   */
  private handleTouchDragStart(
    event: TouchEvent,
    playerId: string,
    sourceType: "inventory" | "equipment",
    slot: number | string,
  ): void {
    const itemData = this.getItemInSlot(playerId, sourceType, slot);
    if (!itemData) return;

    const touch = event.touches[0];
    // Strong type assumption - sourceType determines slot type
    const slotNumber =
      sourceType === "inventory"
        ? (slot as number)
        : parseInt(slot as string, 10) || 0;

    const dragData: DragData = {
      sourceType: sourceType,
      sourceSlot: slotNumber,
      itemId: itemData.id,
      itemData: itemData,
      dragElement: event.target as HTMLElement,
      originalPosition: { x: touch.clientX, y: touch.clientY },
    };

    this.startDrag(dragData);
    this.createDragPreview(itemData, touch.clientX, touch.clientY);

    // Setup touch move handler for preview
    const touchMoveHandler = (moveEvent: TouchEvent) => {
      if (this.dragPreview) {
        const touch = moveEvent.touches[0];
        this.updateDragPreview(touch.clientX, touch.clientY);
      }
    };

    document.addEventListener("touchmove", touchMoveHandler);

    // Store handler for cleanup
    // Store touch handler reference for cleanup
    (this as { touchMoveHandler?: (e: TouchEvent) => void }).touchMoveHandler =
      touchMoveHandler;
  }

  /**
   * Start drag operation
   */
  private startDrag(dragData: DragData): void {
    this.currentDrag = dragData;
    this.isDragging = true;

    // Add visual feedback
    if (dragData.dragElement) {
      dragData.dragElement.classList.add("dragging");
    }

    // Highlight valid drop targets
    this.highlightValidDropTargets(dragData.itemData);

    // Log drag start for debugging
    Logger.system("InventoryInteractionSystem", "Drag started", {
      sourceType: dragData.sourceType,
      sourceSlot: dragData.sourceSlot,
      itemId: dragData.itemId,
    });
  }

  /**
   * Handle drag over event
   */
  private handleDragOver(event: DragEvent, target: DropTarget): void {
    if (!this.currentDrag) return;

    // Check if this target accepts the current item
    if (this.canDropOnTarget(this.currentDrag.itemData, target)) {
      event.preventDefault();
      event.dataTransfer!.dropEffect = "move";

      // Add hover effect
      target.element.classList.add("drop-hover");
    }
  }

  /**
   * Handle drop event
   */
  private handleDropEvent(event: DragEvent, target: DropTarget): void {
    event.preventDefault();

    if (!this.currentDrag) return;

    // Remove hover effect
    target.element.classList.remove("drop-hover");

    // Check if drop is valid
    if (!this.canDropOnTarget(this.currentDrag.itemData, target)) {
      this.logger.warn(
        `Invalid drop: ${this.currentDrag.itemData.name} cannot be dropped on ${target.type} slot ${String(target.slot)}`,
      );
      this.cancelDrag();
      return;
    }

    // Perform the drop
    this.performDrop(this.currentDrag, target);
  }

  /**
   * Handle touch drag end
   */
  private handleTouchDragEnd(): void {
    if (!this.currentDrag) return;

    // Find drop target under the current position
    if (this.dragPreview) {
      const rect = this.dragPreview.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Find element under the drag preview
      this.dragPreview.style.display = "none";
      const elementUnder = document.elementFromPoint(centerX, centerY);
      this.dragPreview.style.display = "block";

      if (elementUnder) {
        const target = this.findDropTargetForElement(elementUnder);
        if (target && this.canDropOnTarget(this.currentDrag.itemData, target)) {
          this.performDrop(this.currentDrag, target);
          return;
        }
      }
    }

    // No valid drop target found
    this.cancelDrag();
  }

  /**
   * Handle HTML5 drag end
   */
  private handleDragEndEvent(_event: DragEvent): void {
    this.endDrag();
  }

  /**
   * Perform the actual drop operation
   */
  private performDrop(dragData: DragData, target: DropTarget): void {
    // Handle different drop scenarios
    if (dragData.sourceType === "inventory" && target.type === "equipment") {
      // Equip item - use TRY_EQUIP to auto-detect slot
      this.emitTypedEvent(EventType.EQUIPMENT_TRY_EQUIP, {
        playerId: this.getCurrentPlayerId(),
        itemId: dragData.itemId,
      });
    } else if (
      dragData.sourceType === "equipment" &&
      target.type === "inventory"
    ) {
      // Unequip item
      this.emitTypedEvent(EventType.EQUIPMENT_UNEQUIP, {
        playerId: this.getCurrentPlayerId(),
        slot: dragData.sourceSlot,
      });
    } else if (
      dragData.sourceType === "inventory" &&
      target.type === "inventory"
    ) {
      // Move item within inventory
      this.emitTypedEvent(EventType.INVENTORY_MOVE, {
        playerId: this.getCurrentPlayerId(),
        fromSlot: dragData.sourceSlot,
        toSlot: target.slot,
      });
    } else if (
      dragData.sourceType === "equipment" &&
      target.type === "equipment"
    ) {
      // Swap equipment (if compatible)
      this.logger.info("Equipment swap", {
        playerId: this.getCurrentPlayerId(),
        fromSlot: dragData.sourceSlot,
        toSlot: target.slot,
      });
    }

    this.endDrag();
  }

  /**
   * Cancel drag operation
   */
  private cancelDrag(): void {
    this.endDrag();
  }

  /**
   * End drag operation and cleanup
   */
  private endDrag(): void {
    if (this.currentDrag) {
      // Remove visual feedback
      if (this.currentDrag.dragElement) {
        this.currentDrag.dragElement.classList.remove("dragging");
      }

      // Log drag end for debugging
      this.logger.info("Drag ended", {
        sourceType: this.currentDrag.sourceType,
        sourceSlot: this.currentDrag.sourceSlot,
        itemId: this.currentDrag.itemId,
      });
    }

    // Clear drag state
    this.currentDrag = undefined;
    this.isDragging = false;

    // Remove drag preview
    this.removeDragPreview();

    // Remove highlight from drop targets
    this.clearDropTargetHighlights();

    // Cleanup touch handler
    // Clean up touch handler
    const self = this as { touchMoveHandler?: (e: TouchEvent) => void };
    if (self.touchMoveHandler) {
      document.removeEventListener("touchmove", self.touchMoveHandler);
      self.touchMoveHandler = undefined;
    }
  }

  /**
   * Create visual drag preview
   */
  private createDragPreview(itemData: Item, x: number, y: number): void {
    this.dragPreview = document.createElement("div");
    this.dragPreview.className = "drag-preview";
    this.dragPreview.style.cssText = `
      position: fixed;
      top: ${y - 20}px;
      left: ${x - 20}px;
      width: 40px;
      height: 40px;
      background: ${this.getItemColor(itemData)};
      border: 2px solid #fff;
      border-radius: 4px;
      pointer-events: none;
      z-index: 10000;
      opacity: 0.8;
      transform: rotate(5deg);
    `;

    // Add item name
    const label = document.createElement("div");
    label.textContent = itemData.name;
    label.style.cssText = `
      position: absolute;
      top: 45px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 12px;
      white-space: nowrap;
    `;
    this.dragPreview.appendChild(label);

    document.body.appendChild(this.dragPreview);

    // Update position on mouse move
    const mouseMoveHandler = (event: MouseEvent) => {
      if (this.dragPreview) {
        this.updateDragPreview(event.clientX, event.clientY);
      }
    };

    document.addEventListener("mousemove", mouseMoveHandler);
    // Store mouse handler reference for cleanup
    (this as { mouseMoveHandler?: (e: MouseEvent) => void }).mouseMoveHandler =
      mouseMoveHandler;
  }

  /**
   * Update drag preview position
   */
  private updateDragPreview(x: number, y: number): void {
    if (this.dragPreview) {
      this.dragPreview.style.left = `${x - 20}px`;
      this.dragPreview.style.top = `${y - 20}px`;
    }
  }

  /**
   * Remove drag preview
   */
  private removeDragPreview(): void {
    if (this.dragPreview) {
      document.body.removeChild(this.dragPreview);
      this.dragPreview = undefined;
    }

    // Remove mouse move handler
    // Clean up mouse handler
    const self = this as { mouseMoveHandler?: (e: MouseEvent) => void };
    if (self.mouseMoveHandler) {
      document.removeEventListener("mousemove", self.mouseMoveHandler);
      self.mouseMoveHandler = undefined;
    }
  }

  /**
   * Highlight valid drop targets
   */
  private highlightValidDropTargets(itemData: Item): void {
    for (const target of this.dropTargets.values()) {
      if (this.canDropOnTarget(itemData, target)) {
        target.element.classList.add("drop-valid");
      } else {
        target.element.classList.add("drop-invalid");
      }
    }
  }

  /**
   * Clear drop target highlights
   */
  private clearDropTargetHighlights(): void {
    for (const target of this.dropTargets.values()) {
      target.element.classList.remove(
        "drop-valid",
        "drop-invalid",
        "drop-hover",
      );
    }
  }

  /**
   * Check if item can be dropped on target
   */
  private canDropOnTarget(itemData: Item, target: DropTarget): boolean {
    // Check if target accepts this item type
    if (!target.accepts.includes(itemData.type.toString())) {
      return false;
    }

    // Additional checks for equipment slots
    if (target.type === "equipment") {
      const slotType = target.slot as string;

      // Check specific equipment slot compatibility
      const item = itemData as Item;
      if (slotType === "weapon" && item.type.toString() !== "weapon")
        return false;
      if (slotType === "shield" && item.type.toString() !== "shield")
        return false;
      if (slotType === "arrows" && item.type.toString() !== "ammunition")
        return false;
      if (
        (slotType === "helmet" || slotType === "body" || slotType === "legs") &&
        item.type.toString() !== "armor"
      )
        return false;

      // Check armor slot compatibility
      if (item.type.toString() === "armor" && item.equipSlot !== slotType)
        return false;
    }

    return true;
  }

  /**
   * Get accepted item types for equipment slot
   */
  private getAcceptedTypesForEquipmentSlot(slotType: string): string[] {
    switch (slotType) {
      case "weapon":
        return ["weapon"];
      case "shield":
        return ["shield"];
      case "helmet":
      case "body":
      case "legs":
        return ["armor"];
      case "arrows":
        return ["ammunition"];
      default:
        return [];
    }
  }

  /**
   * Get item data from slot
   */
  private getItemInSlot(
    playerId: string,
    sourceType: "inventory" | "equipment",
    slot: number | string,
  ): Item | null {
    if (sourceType === "inventory") {
      // Strong type assumption - inventory slots are numbers
      return this.getInventoryItem(playerId, slot as number);
    } else if (sourceType === "equipment") {
      // Strong type assumption - equipment slots are strings
      return this.getEquipmentItem(playerId, slot as string);
    }

    return null;
  }

  private getInventoryItem(playerId: string, slot: number): Item | null {
    // Use event-based approach to get inventory item

    let inventoryItem: Item | null = null;

    // Request item from inventory system via events
    this.emitTypedEvent(EventType.INVENTORY_CHECK, {
      playerId: playerId,
      slot: slot,

      callback: (item: Item | null) => {
        if (item) {
          inventoryItem = this.createCompleteItem(item);
        }
      },
    });

    return inventoryItem;
  }

  private getEquipmentItem(playerId: string, slot: string): Item | null {
    // Use cached equipment data (reactive pattern)
    const equipment = this.playerEquipment.get(playerId);
    if (!equipment || !equipment[slot]) {
      return null;
    }

    const item = equipment[slot];
    return this.createCompleteItem({
      ...item,
      quantity: 1, // Equipment items are always quantity 1
      stackable: false,
    });
  }

  /**
   * Find drop target for element
   */
  private findDropTargetForElement(element: Element): DropTarget | null {
    // Walk up the DOM tree to find a drop target
    let currentElement: Element | null = element;

    while (currentElement) {
      for (const target of this.dropTargets.values()) {
        if (
          target.element === currentElement ||
          target.element.contains(currentElement)
        ) {
          return target;
        }
      }
      currentElement = currentElement.parentElement;
    }

    return null;
  }

  /**
   * Get current player ID (simplified for MVP)
   */
  private getCurrentPlayerId(): string {
    const localPlayer = this.world.getPlayer();
    return localPlayer?.id || "player1";
  }

  /**
   * Get item color for visual representation
   */
  private getItemColor(itemData: Item): string {
    const colorMap: Record<string, string> = {
      weapon: "#ffffff",
      armor: "#8b4513",
      shield: "#4169e1",
      ammunition: "#ffd700",
      food: "#32cd32",
      tool: "#c0c0c0",
      resource: "#654321",
    };

    return colorMap[itemData.type] || "#808080";
  }

  /**
   * Cleanup interactions
   */
  private cleanupInteractions(): void {
    // Abort all element event listeners
    for (const controller of this.elementAbortControllers.values()) {
      controller.abort();
    }
    this.elementAbortControllers.clear();

    this.dropTargets.clear();
    if (this.isDragging) {
      this.cancelDrag();
    }
  }

  /**
   * Handle player join
   */
  private handlePlayerJoin(_event: { playerId: string }): void {}

  /**
   * Handle player leave
   */
  private handlePlayerLeave(event: { playerId: string }): void {
    // Clean up any drag operations for this player
    if (this.currentDrag && this.getCurrentPlayerId() === event.playerId) {
      this.cancelDrag();
    }
    // Clean up context menu
    this.closeContextMenu(event.playerId);
  }

  /**
   * Handle system-level drag start
   */
  private handleDragStart(_event: unknown): void {
    // System-level drag start handling if needed
  }

  /**
   * Handle system-level drag end
   */
  private handleDragEnd(_event: unknown): void {
    // System-level drag end handling if needed
  }

  /**
   * Handle system-level drop
   */
  private handleDrop(_event: unknown): void {
    // System-level drop handling if needed
  }

  /**
   * Get system info for debugging
   */
  getSystemInfo(): {
    isDragging: boolean;
    dropTargetsCount: number;
    currentDrag: {
      sourceType: string;
      sourceSlot: number;
      itemId: string;
    } | null;
  } {
    return {
      isDragging: this.isDragging,
      dropTargetsCount: this.dropTargets.size,
      currentDrag: this.currentDrag
        ? {
            sourceType: this.currentDrag.sourceType,
            sourceSlot: this.currentDrag.sourceSlot,
            itemId: this.currentDrag.itemId,
          }
        : null,
    };
  }

  /**
   * Optimistically remove an item from the client inventory cache.
   * Delegates to ClientNetwork which handles snapshot + rollback tracking.
   */
  private applyOptimisticRemoval(
    playerId: string,
    slot: number,
    quantity: number,
  ): void {
    this.clientNetwork?.applyOptimisticRemoval(playerId, slot, quantity);
  }

  destroy(): void {
    this.cleanupInteractions();
    this.currentDrag = undefined;
    this.contextMenus.clear();
    this.itemActions.clear();
    this.playerEquipment.clear();

    // Ensure all element listeners are cleaned up
    for (const controller of this.elementAbortControllers.values()) {
      controller.abort();
    }
    this.elementAbortControllers.clear();
  }

  // === ITEM ACTION METHODS (merged from ItemActionSystem) ===

  /**
   * Register default item actions for all item types
   */
  private registerDefaultActions(): void {
    // Equipment actions
    this.registerAction("equipment", {
      id: "wear",
      label: "Wear",
      priority: 1,
      condition: (item: Item) => this.isEquippable(item),
      callback: (playerId: string, itemId: string, _slot: number | null) => {
        this.emitTypedEvent(EventType.EQUIPMENT_TRY_EQUIP, {
          playerId: playerId,
          itemId: itemId,
        });
      },
    });

    this.registerAction("equipment", {
      id: "remove",
      label: "Remove",
      priority: 1,
      condition: (item: Item, playerId: string) =>
        this.isEquippedItem(item, playerId),
      callback: (playerId: string, itemId: string, _slot: number | null) => {
        const item = this.getItemData(itemId);
        if (item) {
          const equipSlot = this.getEquipmentSlotForItem(item);
          if (equipSlot) {
            this.emitTypedEvent(EventType.EQUIPMENT_UNEQUIP, {
              playerId: playerId,
              slot: equipSlot,
            });
          }
        }
      },
    });

    // Consumption actions (eating food)
    // Uses INVENTORY_USE instead of INVENTORY_CONSUME_ITEM because:
    // - INVENTORY_USE → InventorySystem.useItem() → ITEM_USED → PlayerSystem.handleItemUsed() → healing
    // - INVENTORY_CONSUME_ITEM has no subscriber (was broken)
    // NOTE: Must use "consumable" (item.type) not "food" - getAvailableActions() looks up by item.type
    this.registerAction("consumable", {
      id: "eat",
      label: "Eat",
      priority: 1,
      condition: (item: Item) => item.type === ItemType.CONSUMABLE,
      callback: (playerId: string, itemId: string, slot: number | null) => {
        // Validate slot is within bounds (OWASP: Input Validation)
        const validSlot =
          slot !== null && slot >= 0 && slot < INPUT_LIMITS.MAX_INVENTORY_SLOTS
            ? slot
            : 0;

        // Route through existing INVENTORY_USE pipeline which handles:
        // - Item verification at slot
        // - Item consumption
        // - ITEM_USED event emission
        this.emitTypedEvent(EventType.INVENTORY_USE, {
          playerId,
          itemId,
          slot: validSlot,
        });
      },
    });

    // Tool actions
    this.registerAction("tool", {
      id: "use",
      label: "Use",
      priority: 1,
      condition: (item: Item) => item.type === ItemType.TOOL,
      callback: (playerId: string, itemId: string, slot: number | null) => {
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId: playerId,
          itemId: itemId,
          slot: slot,
        });
      },
    });

    // === classic MMORPG-STYLE "USE" ACTIONS FOR FIREMAKING/COOKING ===

    // Tinderbox: Use on logs to light fire
    this.registerAction("processing", {
      id: "use",
      label: "Use",
      priority: 1,
      condition: (item: Item) => item.id === "tinderbox",
      callback: (playerId: string, itemId: string, slot: number | null) => {
        this.startTargetingMode(playerId, itemId, slot ?? 0);
      },
    });

    // Logs: Use on tinderbox (reverse direction also works in classic MMORPG)
    this.registerAction("processing", {
      id: "use",
      label: "Use",
      priority: 1,
      condition: (item: Item) => processingDataProvider.isBurnableLog(item.id),
      callback: (playerId: string, itemId: string, slot: number | null) => {
        this.startTargetingMode(playerId, itemId, slot ?? 0);
      },
    });

    // Raw food: Use on fire or range to cook
    this.registerAction("processing", {
      id: "use",
      label: "Use",
      priority: 1,
      condition: (item: Item) => processingDataProvider.isCookable(item.id),
      callback: (playerId: string, itemId: string, slot: number | null) => {
        this.startTargetingMode(playerId, itemId, slot ?? 0);
      },
    });

    // Ore: Use on furnace to smelt
    this.registerAction("processing", {
      id: "use",
      label: "Use",
      priority: 1,
      condition: (item: Item) => processingDataProvider.isSmeltableOre(item.id),
      callback: (playerId: string, itemId: string, slot: number | null) => {
        this.startTargetingMode(playerId, itemId, slot ?? 0);
      },
    });

    // Needle: Use on leather/hides to craft
    this.registerAction("processing", {
      id: "use",
      label: "Use",
      priority: 1,
      condition: (item: Item) => item.id === "needle",
      callback: (playerId: string, itemId: string, slot: number | null) => {
        this.startTargetingMode(playerId, itemId, slot ?? 0);
      },
    });

    // Chisel: Use on uncut gems to cut
    this.registerAction("processing", {
      id: "use",
      label: "Use",
      priority: 1,
      condition: (item: Item) => item.id === "chisel",
      callback: (playerId: string, itemId: string, slot: number | null) => {
        this.startTargetingMode(playerId, itemId, slot ?? 0);
      },
    });

    // Crafting inputs (leather, uncut gems): Use on tool (reverse direction)
    this.registerAction("processing", {
      id: "use",
      label: "Use",
      priority: 1,
      condition: (item: Item) =>
        processingDataProvider.isCraftingInput(item.id),
      callback: (playerId: string, itemId: string, slot: number | null) => {
        this.startTargetingMode(playerId, itemId, slot ?? 0);
      },
    });

    // Knife: Use on logs to fletch bows/arrow shafts
    this.registerAction("processing", {
      id: "use",
      label: "Use",
      priority: 1,
      condition: (item: Item) => item.id === "knife",
      callback: (playerId: string, itemId: string, slot: number | null) => {
        this.startTargetingMode(playerId, itemId, slot ?? 0);
      },
    });

    // Fletching inputs (bowstring, arrowtips, headless arrows, etc.): Use for item-on-item
    this.registerAction("processing", {
      id: "use",
      label: "Use",
      priority: 1,
      condition: (item: Item) =>
        processingDataProvider.isFletchingInput(item.id) &&
        !processingDataProvider.isBurnableLog(item.id),
      callback: (playerId: string, itemId: string, slot: number | null) => {
        this.startTargetingMode(playerId, itemId, slot ?? 0);
      },
    });

    // Universal actions
    this.registerAction("universal", {
      id: "examine",
      label: "Examine",
      priority: 10,
      condition: () => true,
      callback: (playerId: string, itemId: string) => {
        const item = this.getItemData(itemId);
        if (item) {
          const description =
            item.description || `A ${item.name.toLowerCase()}.`;
          this.emitTypedEvent(EventType.UI_MESSAGE, {
            playerId: playerId,
            message: description,
            type: "info",
          });
        }
      },
    });

    this.registerAction("universal", {
      id: "drop",
      label: "Drop",
      priority: 9,
      condition: (item: Item, playerId: string) =>
        !this.isEquippedItem(item, playerId),
      callback: (playerId: string, itemId: string, slot: number | null) => {
        const normalizedSlot = slot ?? undefined;
        if (!this.world.isServer) {
          const network = this.world.network as unknown as {
            dropItem?: (
              requestedItemId: string,
              requestedSlot?: number,
              requestedQuantity?: number,
            ) => string;
          };
          network.dropItem?.(itemId, normalizedSlot, 1);
          return;
        }
        this.emitTypedEvent(EventType.ITEM_DROP, {
          playerId: playerId,
          itemId: itemId,
          quantity: 1,
          slot: normalizedSlot,
        });
      },
    });

    // Ground item actions
    this.registerAction("ground", {
      id: "take",
      label: "Take",
      priority: 1,
      condition: () => true,
      callback: (playerId: string, itemId: string) => {
        this.emitTypedEvent(EventType.ITEM_PICKUP, {
          playerId: playerId,
          itemId: itemId,
        });
      },
    });
  }

  /**
   * Register a new item action
   */
  public registerAction(category: string, action: ItemAction): void {
    if (!this.itemActions.has(category)) {
      this.itemActions.set(category, []);
    }

    const actions = this.itemActions.get(category)!;
    actions.push(action);
    actions.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Handle right-click on inventory item
   */
  private handleItemRightClick(event: {
    playerId: string;
    itemId: string;
    slot?: number;
    position?: { x: number; y: number };
  }): void {
    const item = this.getItemData(event.itemId);
    if (!item) {
      Logger.system(
        "InventoryInteractionSystem",
        `Item not found: ${event.itemId}`,
      );
      return;
    }

    const availableActions = this.getAvailableActions(item, event.playerId);

    if (availableActions.length === 0) {
      Logger.system(
        "InventoryInteractionSystem",
        `No actions available for item: ${item.name}`,
      );
      return;
    }

    const contextMenu: ItemContextMenu = {
      playerId: event.playerId,
      itemId: event.itemId,
      slot: event.slot || null,
      actions: availableActions,
      position: event.position || { x: 0, y: 0 },
      visible: true,
    };

    this.contextMenus.set(event.playerId, contextMenu);

    this.emitTypedEvent(EventType.UI_OPEN_MENU, {
      playerId: event.playerId,
      actions: availableActions.map((action) => action.label),
    });
  }

  /**
   * Handle corpse/gravestone click - opens loot UI in the active client interface
   * This handler is kept for logging/debugging purposes
   */
  private handleCorpseClick(event: {
    corpseId: string;
    playerId: string;
    lootItems?: Array<{ itemId: string; quantity: number }>;
    position: { x: number; y: number; z: number };
  }): void {
    Logger.system(
      "InventoryInteractionSystem",
      `CORPSE_CLICK event received for ${event.corpseId} with ${event.lootItems?.length || 0} items - LootWindow should open in client UI`,
    );
    // Note: The actual loot UI (LootWindow) is rendered by the active client interface
    // which listens to this event and displays the loot interface
  }

  /**
   * Handle action selection from context menu or direct invocation.
   *
   * Can be called either:
   * 1. From context menu (has stored contextMenu) - legacy flow
   * 2. Directly with itemId/slot (client-side menu) - new flow
   */
  private handleActionSelected(event: {
    playerId: string;
    actionId: string;
    itemId?: string;
    slot?: number;
  }): void {
    // Try to get from stored context menu first (legacy flow)
    const contextMenu = this.contextMenus.get(event.playerId);

    // Determine item info from either context menu or direct event
    const itemId = event.itemId ?? contextMenu?.itemId;
    const slot = event.slot ?? contextMenu?.slot ?? 0;

    if (!itemId) {
      Logger.system(
        "InventoryInteractionSystem",
        `No itemId available for action: ${event.actionId}`,
      );
      return;
    }

    // Get the item data to find available actions
    const item = this.getItemData(itemId);
    if (!item) {
      Logger.system("InventoryInteractionSystem", `Item not found: ${itemId}`);
      return;
    }

    // Get all available actions for this item
    const availableActions = this.getAvailableActions(item, event.playerId);
    const action = availableActions.find((a) => a.id === event.actionId);

    if (!action) {
      Logger.system(
        "InventoryInteractionSystem",
        `Action "${event.actionId}" not found for item: ${itemId}`,
      );
      return;
    }

    // Execute the action callback
    action.callback(event.playerId, itemId, slot);

    // Clean up context menu if it exists
    if (contextMenu) {
      this.closeContextMenu(event.playerId);
    }
  }

  /**
   * Close context menu for player
   */
  private closeContextMenu(playerId: string): void {
    this.contextMenus.delete(playerId);

    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId: playerId,
    });
  }

  /**
   * Get available actions for an item
   */
  private getAvailableActions(item: Item, playerId: string): ItemAction[] {
    const availableActions: ItemAction[] = [];

    const equipmentActions = this.itemActions.get("equipment") || [];
    for (const action of equipmentActions) {
      if (!action.condition || action.condition(item, playerId)) {
        availableActions.push(action);
      }
    }

    // Processing actions (firemaking/cooking - tinderbox, logs, raw food)
    const processingActions = this.itemActions.get("processing") || [];
    for (const action of processingActions) {
      if (!action.condition || action.condition(item, playerId)) {
        availableActions.push(action);
      }
    }

    const typeActions = this.itemActions.get(item.type) || [];
    for (const action of typeActions) {
      if (!action.condition || action.condition(item, playerId)) {
        availableActions.push(action);
      }
    }

    const universalActions = this.itemActions.get("universal") || [];
    for (const action of universalActions) {
      if (!action.condition || action.condition(item, playerId)) {
        availableActions.push(action);
      }
    }

    const uniqueActions = new Map<string, ItemAction>();
    for (const action of availableActions) {
      if (
        !uniqueActions.has(action.id) ||
        uniqueActions.get(action.id)!.priority > action.priority
      ) {
        uniqueActions.set(action.id, action);
      }
    }

    return Array.from(uniqueActions.values()).sort(
      (a, b) => a.priority - b.priority,
    );
  }

  /**
   * Helper methods for item actions
   */
  private isEquippable(item: Item): boolean {
    return [ItemType.WEAPON, ItemType.ARMOR, ItemType.AMMUNITION].includes(
      item.type,
    );
  }

  private isEquippedItem(item: Item, playerId: string): boolean {
    let isEquipped = false;
    this.emitTypedEvent(EventType.UI_MESSAGE, {
      playerId: playerId,
      itemId: item.id,
      callback: (equipped: boolean) => {
        isEquipped = equipped;
      },
    });
    return isEquipped;
  }

  private getEquipmentSlotForItem(item: Item): string | null {
    switch (item.type) {
      case ItemType.WEAPON:
        return "weapon";
      case ItemType.ARMOR:
        return item.equipSlot || null;
      case ItemType.AMMUNITION:
        return "arrows";
      default:
        return null;
    }
  }

  private getItemData(itemId: string): Item | null {
    return dataManager.getItem(itemId);
  }

  // === TARGETING MODE FOR classic MMORPG-STYLE "USE X ON Y" ===

  /**
   * Start targeting mode for "Use X on Y" interactions.
   * Validates item and determines valid targets (inventory items or world entities).
   *
   * @param playerId - Player starting the interaction
   * @param itemId - Item being used (tinderbox, logs, raw food)
   * @param slot - Inventory slot of the source item
   */
  private startTargetingMode(
    playerId: string,
    itemId: string,
    slot: number,
  ): void {
    const validator = getTargetValidator();
    const validation = validator.validateUse({ id: itemId, slot }, playerId);

    if (!validation.canUse) {
      // Show error message (e.g., "You need some logs to light.")
      this.emitTypedEvent(EventType.UI_MESSAGE, {
        playerId,
        message: validation.error || "Nothing interesting happens.",
        type: "error",
      });
      return;
    }

    // Emit targeting start event for UI to show cursor change and highlights
    this.emitTypedEvent(EventType.TARGETING_START, {
      playerId,
      sourceItem: { id: itemId, slot, name: itemId },
      validTargetTypes: validation.validTargetTypes,
      validTargetIds: Array.from(validation.validTargetIds),
      actionType: validation.actionType,
    });

    Logger.system(
      "InventoryInteractionSystem",
      `Started targeting: ${itemId} → ${validation.actionType}`,
      {
        validTargets: validation.validTargetIds.size,
        targetTypes: validation.validTargetTypes,
      },
    );
  }

  /**
   * Handle target selection during targeting mode.
   * Called when player clicks a valid target (inventory item or world entity).
   *
   * @param playerId - Player ID
   * @param sourceItemId - Source item being used
   * @param sourceSlot - Source item slot
   * @param targetId - Target item/entity ID
   * @param targetType - Target type (inventory_item or world_entity)
   * @param targetSlot - Target slot (for inventory items)
   */
  public handleTargetSelected(
    playerId: string,
    sourceItemId: string,
    sourceSlot: number,
    targetId: string,
    targetType: "inventory_item" | "world_entity",
    targetSlot?: number,
  ): void {
    console.log(
      "[InventoryInteractionSystem] 🎯 handleTargetSelected called:",
      {
        playerId,
        sourceItemId,
        sourceSlot,
        targetId,
        targetType,
        targetSlot,
      },
    );

    const validator = getTargetValidator();
    const actionType = validator.getActionType(sourceItemId);
    console.log("[InventoryInteractionSystem] 🎯 Action type:", actionType);

    if (actionType === "firemaking") {
      // Firemaking: tinderbox + logs or logs + tinderbox
      // Determine which is logs and which is tinderbox
      const isSourceLogs = processingDataProvider.isBurnableLog(sourceItemId);
      const logsId = isSourceLogs ? sourceItemId : targetId;
      const logsSlot = isSourceLogs ? sourceSlot : (targetSlot ?? 0);
      const tinderboxSlot = isSourceLogs ? (targetSlot ?? 0) : sourceSlot;

      // Send to server for authoritative processing
      if (this.world.network?.send) {
        console.log(
          "[InventoryInteractionSystem] 🔥 Sending firemakingRequest to server:",
          {
            logsId,
            logsSlot,
            tinderboxSlot,
          },
        );
        this.world.network.send(MESSAGE_TYPES.FIREMAKING_REQUEST, {
          logsId,
          logsSlot,
          tinderboxSlot,
        });

        // Optimistic removal: remove the logs from the client inventory cache
        // so the UI updates immediately (same pattern as eat/drop/bury in
        // InventoryActionDispatcher). The server's authoritative inventoryUpdated
        // packet will replace this cache within ~100-200ms.
        this.applyOptimisticRemoval(playerId, logsSlot, 1);
      } else {
        // Fallback: emit local event (for single-player/testing)
        this.emitTypedEvent(EventType.PROCESSING_FIREMAKING_REQUEST, {
          playerId,
          logsId,
          logsSlot,
          tinderboxSlot,
        });
      }

      Logger.system("InventoryInteractionSystem", "Firemaking request", {
        playerId,
        logsId,
        logsSlot,
        tinderboxSlot,
      });
    } else if (actionType === "cooking") {
      // Cooking: raw food + fire/range
      if (targetType !== "world_entity") {
        this.emitTypedEvent(EventType.UI_MESSAGE, {
          playerId,
          message: "You need to use that on a fire or range.",
          type: "error",
        });
        return;
      }

      // Send to server for authoritative processing
      if (this.world.network?.send) {
        console.log(
          "[InventoryInteractionSystem] 🍳 Sending cookingRequest to server:",
          {
            rawFoodId: sourceItemId,
            rawFoodSlot: sourceSlot,
            fireId: targetId,
          },
        );
        this.world.network.send(MESSAGE_TYPES.COOKING_REQUEST, {
          rawFoodId: sourceItemId,
          rawFoodSlot: sourceSlot,
          fireId: targetId,
        });
      } else {
        // Fallback: emit local event (for single-player/testing)
        this.emitTypedEvent(EventType.PROCESSING_COOKING_REQUEST, {
          playerId,
          fishSlot: sourceSlot,
          fireId: targetId,
        });
      }

      Logger.system("InventoryInteractionSystem", "Cooking request", {
        playerId,
        fishSlot: sourceSlot,
        fireId: targetId,
      });
    } else if (actionType === "crafting") {
      // Crafting: needle + leather, chisel + uncut gem, or reverse
      // Determine trigger type from source item
      let triggerType: "needle" | "chisel" = "needle";
      if (
        sourceItemId === "chisel" ||
        processingDataProvider
          .getCraftingInputsForTool("chisel")
          .has(sourceItemId)
      ) {
        triggerType = "chisel";
      }

      // Determine the input material (the non-tool item)
      let inputItemId = sourceItemId;
      if (sourceItemId === "needle" || sourceItemId === "chisel") {
        inputItemId = targetId; // target is the material
      }
      // else sourceItemId IS the material (reverse targeting: clicked leather then needle)

      // Send to server for authoritative processing
      if (this.world.network?.send) {
        this.world.network.send("craftingSourceInteract", {
          triggerType,
          inputItemId,
        });
      } else {
        // Fallback: emit local event
        this.emitTypedEvent(EventType.CRAFTING_INTERACT, {
          playerId,
          triggerType,
          inputItemId,
        });
      }

      Logger.system("InventoryInteractionSystem", "Crafting request", {
        playerId,
        triggerType,
        inputItemId,
        sourceItemId,
        targetId,
      });
    } else if (actionType === "fletching") {
      // Fletching: knife + logs, bowstring + unstrung bow, arrowtips + headless arrows
      let triggerType: "knife" | "item_on_item" = "item_on_item";
      let inputItemId = sourceItemId;
      let secondaryItemId: string | undefined;

      if (sourceItemId === "knife") {
        // Knife is the tool, target is the material (e.g., logs)
        triggerType = "knife";
        inputItemId = targetId;
      } else if (targetId === "knife") {
        // Reverse: material used on knife
        triggerType = "knife";
        inputItemId = sourceItemId;
      } else {
        // Item-on-item: bowstring + unstrung bow, arrowtips + headless arrows
        triggerType = "item_on_item";
        inputItemId = sourceItemId;
        secondaryItemId = targetId;
      }

      // Send to server for authoritative processing
      if (this.world.network?.send) {
        this.world.network.send("fletchingSourceInteract", {
          triggerType,
          inputItemId,
          secondaryItemId,
        });
      } else {
        // Fallback: emit local event
        this.emitTypedEvent(EventType.FLETCHING_INTERACT, {
          playerId,
          triggerType,
          inputItemId,
          secondaryItemId,
        });
      }

      Logger.system("InventoryInteractionSystem", "Fletching request", {
        playerId,
        triggerType,
        inputItemId,
        secondaryItemId,
        sourceItemId,
        targetId,
      });
    }

    // Emit targeting complete event
    this.emitTypedEvent(EventType.TARGETING_COMPLETE, {
      playerId,
      sourceItem: { id: sourceItemId, slot: sourceSlot },
      target: { type: targetType, id: targetId, slot: targetSlot },
    });
  }
}
