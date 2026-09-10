/**
 * Inventory Panel
 * Modern MMORPG-style inventory interface with drag-and-drop functionality
 */

import { useEffect, useState, useRef, useMemo, useCallback, memo } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  useDraggable,
  useDroppable,
  DragOverlay,
  useSensors,
  useSensor,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  useDragStore,
  TOOLTIP_SIZE_ESTIMATES,
  useThemeStore,
  useMobileLayout,
  CursorTooltip,
} from "@/ui";
import {
  getTooltipBodyStyle,
  getTooltipDividerStyle,
  getTooltipMetaStyle,
  getTooltipTitleStyle,
} from "@/ui/core/tooltip/tooltipStyles";
import {
  getInteractiveTileStyle,
  getPanelInsetStyle,
  getPanelSurfaceStyle,
} from "@/ui/theme/themes";
import { useContextMenuState } from "../../hooks";
import {
  EventType,
  getItem,
  uuid,
  // rules-accurate item helpers (extracted to shared)
  isFood,
  isPotion,
  isBone,
  usesWield,
  usesWear,
  isNotedItem,
  getPrimaryAction,
  CONTEXT_MENU_COLORS,
  INVENTORY_CONSTANTS,
  type PrimaryActionType,
} from "@hyperforge/shared";
import { ItemIcon } from "@/ui/components/ItemIcon";
import { dispatchInventoryAction } from "../systems/InventoryActionDispatcher";
import type { ClientWorld, InventorySlotItem } from "../../types";
import { CoinAmountModal } from "./BankPanel/components/modals/CoinAmountModal";
import { CoinPouch } from "./inventory";
import { zIndex } from "../../constants/tokens";

/**
 * Maximum inventory slots (classic MMORPG-style: 28 slots)
 * Uses INVENTORY_CONSTANTS from shared package as single source of truth
 */
const MAX_SLOTS = INVENTORY_CONSTANTS.MAX_INVENTORY_SLOTS;

type InventorySlotViewItem = Pick<
  InventorySlotItem,
  "slot" | "itemId" | "quantity"
>;

/** Mode for embedded inventory in Bank/Store panels */
type EmbeddedMode = "bank" | "store" | null;

interface InventoryPanelProps {
  items: InventorySlotViewItem[];
  coins: number;
  world?: ClientWorld;
  onItemMove?: (fromIndex: number, toIndex: number) => void;
  onItemUse?: (item: InventorySlotViewItem, index: number) => void;
  onItemEquip?: (item: InventorySlotViewItem) => void;
  /** Embedded mode: 'bank' for deposit, 'store' for sell. Disables drag-drop and changes click behavior */
  embeddedMode?: EmbeddedMode;
  /** Handler for left-click in embedded mode (deposit/sell) */
  onEmbeddedClick?: (item: InventorySlotViewItem, index: number) => void;
  /** Handler for context menu in embedded mode */
  onEmbeddedContextMenu?: (
    e: React.MouseEvent,
    item: InventorySlotViewItem,
    index: number,
  ) => void;
  /** Show coin pouch at bottom (default true, can disable for embedded) */
  showCoinPouch?: boolean;
  /** Footer hint text for embedded mode */
  footerHint?: string;
}

interface DraggableItemProps {
  item: InventorySlotViewItem | null;
  index: number;
  onShiftClick?: (item: InventorySlotViewItem, index: number) => void;
  onPrimaryAction?: (
    item: InventorySlotViewItem,
    index: number,
    actionType: PrimaryActionType,
  ) => void;
  targetingState?: TargetingState;
  onTargetClick?: (item: InventorySlotViewItem, index: number) => void;
  onInvalidTargetClick?: () => void;
  onTargetHover?: (
    item: InventorySlotViewItem,
    position: { x: number; y: number },
  ) => void;
  onTargetHoverEnd?: () => void;
  // modern MMORPG-style hover tooltip (separate from targeting mode)
  onItemHoverStart?: (
    item: InventorySlotViewItem,
    position: { x: number; y: number },
  ) => void;
  onItemHoverMove?: (position: { x: number; y: number }) => void;
  onItemHoverEnd?: () => void;
  // Callback when context menu opens (to suppress hover tooltips)
  onContextMenuOpen?: () => void;
  // Embedded mode props (for Bank/Store)
  embeddedMode?: EmbeddedMode;
  onEmbeddedClick?: (item: InventorySlotViewItem, index: number) => void;
  onEmbeddedContextMenu?: (
    e: React.MouseEvent,
    item: InventorySlotViewItem,
    index: number,
  ) => void;
}

// classic MMORPG-style: 4 columns × 7 rows = 28 slots, all visible (no pagination)

/**
 * Format quantity for classic MMORPG-style display
 * - Under 100K: show exact number
 * - 100K-9.99M: green "123K" format
 * - 10M+: green "12M" format
 */
function formatQuantity(qty: number): { text: string; color: string } {
  if (qty < 100000) {
    return { text: qty.toLocaleString(), color: "rgba(255, 255, 255, 0.95)" };
  } else if (qty < 10000000) {
    const k = Math.floor(qty / 1000);
    return { text: `${k}K`, color: "rgba(0, 255, 128, 0.95)" };
  } else {
    const m = Math.floor(qty / 1000000);
    return { text: `${m}M`, color: "rgba(0, 255, 128, 0.95)" };
  }
}

/**
 * Custom modifier to center the DragOverlay on the cursor.
 * The ComposableDragOverlay uses adjustToPointer=true by default.
 */
// Memoized to prevent re-renders of all 28 slots when any slot changes
const DraggableInventorySlot = memo(function DraggableInventorySlot({
  item,
  index,
  onShiftClick,
  onPrimaryAction,
  targetingState,
  onTargetClick,
  onInvalidTargetClick,
  onTargetHover,
  onTargetHoverEnd,
  onItemHoverStart,
  onItemHoverMove,
  onItemHoverEnd,
  onContextMenuOpen,
  embeddedMode,
  onEmbeddedClick,
  onEmbeddedContextMenu,
}: DraggableItemProps) {
  const theme = useThemeStore((s) => s.theme);
  const [isHovered, setIsHovered] = useState(false);
  // In embedded mode, disable drag-drop
  const isDragDisabled = !!embeddedMode || !item;

  // Use both draggable (for picking up) and droppable (for receiving)
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableRef,
    isDragging,
  } = useDraggable({
    id: `inventory-${index}`,
    data: { item, index, source: "inventory" },
    disabled: isDragDisabled,
  });

  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `inventory-drop-${index}`,
    data: { index },
    disabled: !!embeddedMode,
  });

  // Combine refs for both draggable and droppable on same element

  const setNodeRef = (node: HTMLButtonElement | null) => {
    setDraggableRef(node);
    setDroppableRef(node);
  };

  // Slots stay fixed - no transform! Only the DragOverlay moves.
  const isEmpty = !item;

  // classic MMORPG-style targeting mode checks
  const isTargetingActive = targetingState?.active ?? false;

  // Check if THIS slot is the source item (gets white border in classic MMORPG)
  const isSourceItem =
    isTargetingActive && targetingState?.sourceItem?.slot === index;

  // Check if this item is a valid target during targeting mode
  const isValidTarget =
    isTargetingActive &&
    item &&
    !isSourceItem && // Source item is not a valid target
    (targetingState?.validTargetIds.has(item.itemId) ?? false);

  // BANK NOTE SYSTEM: Check if item is a bank note
  // Used for visual styling (parchment background) and context menu filtering
  // Memoized to avoid re-computation on every render
  const itemData = useMemo(() => {
    return item ? getItem(item.itemId) : null;
  }, [item?.itemId]);

  const isItemNoted = useMemo(() => {
    return isNotedItem(itemData);
  }, [itemData]);

  const slotChrome = useMemo(
    () =>
      getInteractiveTileStyle(theme, {
        active: isSourceItem,
        hovered: isHovered && !isEmpty,
        dragging: isDragging,
        dropTarget: isOver,
        radius: 4,
        accentColor: theme.colors.accent.secondary,
      }),
    [theme, isSourceItem, isHovered, isEmpty, isDragging, isOver],
  );

  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-testid="inventory-slot"
      className="relative border rounded transition-all duration-100 group w-full h-full"
      onClick={(e) => {
        // Embedded mode: simple click to deposit/sell
        if (embeddedMode && item && onEmbeddedClick) {
          e.preventDefault();
          e.stopPropagation();
          onEmbeddedClick(item, index);
          return;
        }

        // Handle targeting mode clicks (Use X on Y)
        if (isTargetingActive) {
          e.preventDefault();
          e.stopPropagation();
          if (isValidTarget && item && onTargetClick) {
            onTargetClick(item, index);
          } else if (item && !isValidTarget && onInvalidTargetClick) {
            // classic MMORPG: Clicking an invalid item shows "Nothing interesting happens."
            // (Empty slots don't trigger this - only actual items)
            onInvalidTargetClick();
          }
          // Clicking empty slot does nothing (classic MMORPG behavior)
          return;
        }

        // Shift-click to drop instantly (classic MMORPG-style)
        if (e.shiftKey && item && onShiftClick) {
          e.preventDefault();
          e.stopPropagation();
          onShiftClick(item, index);
          return;
        }

        // Left-click: execute primary action (classic MMORPG-style)
        // Uses manifest-first approach with heuristic fallback
        // Uses memoized itemData and isItemNoted for efficiency
        if (item && onPrimaryAction) {
          e.preventDefault();
          e.stopPropagation();

          const actionType = getPrimaryAction(itemData, isItemNoted);
          onPrimaryAction(item, index, actionType);
        }
      }}
      onMouseEnter={(e) => {
        setIsHovered(true);
        // classic MMORPG-style: show "Use X → Y" tooltip when hovering valid target
        if (isValidTarget && item && onTargetHover) {
          onTargetHover(item, { x: e.clientX, y: e.clientY });
        } else if (!isTargetingActive && item && onItemHoverStart) {
          // modern MMORPG-style: show item stats tooltip when not in targeting mode
          onItemHoverStart(item, { x: e.clientX, y: e.clientY });
        }
      }}
      onMouseLeave={() => {
        setIsHovered(false);
        if (onTargetHoverEnd) {
          onTargetHoverEnd();
        }
        if (onItemHoverEnd) {
          onItemHoverEnd();
        }
      }}
      onMouseMove={(e) => {
        // Update tooltip position as mouse moves
        if (isValidTarget && item && onTargetHover) {
          onTargetHover(item, { x: e.clientX, y: e.clientY });
        } else if (!isTargetingActive && item && onItemHoverMove) {
          onItemHoverMove({ x: e.clientX, y: e.clientY });
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();

        // Hide hover tooltip and mark context menu as open
        if (onItemHoverEnd) {
          onItemHoverEnd();
        }
        if (onContextMenuOpen) {
          onContextMenuOpen();
        }

        if (!item) return;

        // Embedded mode: use custom context menu handler
        if (embeddedMode && onEmbeddedContextMenu) {
          onEmbeddedContextMenu(e, item, index);
          return;
        }

        // Use memoized itemData and isItemNoted for efficiency
        const itemName = itemData?.name || item.itemId;
        const isNoted = isItemNoted;

        // Build menu items - rules-accurate: use inventoryActions from manifest if available
        const menuItems: Array<{
          id: string;
          label: string;
          styledLabel: Array<{ text: string; color?: string }>;
          enabled: boolean;
        }> = [];

        // rules-accurate: Check manifest's inventoryActions first
        if (
          itemData?.inventoryActions &&
          itemData.inventoryActions.length > 0 &&
          !isNoted
        ) {
          // Use explicit actions from manifest
          for (const action of itemData.inventoryActions) {
            const actionLower = action.toLowerCase();
            menuItems.push({
              id: actionLower,
              label: `${action} ${itemName}`,
              styledLabel: [
                { text: `${action} ` },
                { text: itemName, color: CONTEXT_MENU_COLORS.ITEM },
              ],
              enabled: true,
            });
          }
        } else if (!isNoted) {
          // Fallback to heuristic detection for items without inventoryActions
          if (isFood(itemData)) {
            menuItems.push({
              id: "eat",
              label: `Eat ${itemName}`,
              styledLabel: [
                { text: "Eat " },
                { text: itemName, color: CONTEXT_MENU_COLORS.ITEM },
              ],
              enabled: true,
            });
          } else if (isPotion(itemData)) {
            menuItems.push({
              id: "drink",
              label: `Drink ${itemName}`,
              styledLabel: [
                { text: "Drink " },
                { text: itemName, color: CONTEXT_MENU_COLORS.ITEM },
              ],
              enabled: true,
            });
          } else if (isBone(itemData)) {
            menuItems.push({
              id: "bury",
              label: `Bury ${itemName}`,
              styledLabel: [
                { text: "Bury " },
                { text: itemName, color: CONTEXT_MENU_COLORS.ITEM },
              ],
              enabled: true,
            });
          } else if (usesWield(itemData)) {
            menuItems.push({
              id: "wield",
              label: `Wield ${itemName}`,
              styledLabel: [
                { text: "Wield " },
                { text: itemName, color: CONTEXT_MENU_COLORS.ITEM },
              ],
              enabled: true,
            });
          } else if (usesWear(itemData)) {
            menuItems.push({
              id: "wear",
              label: `Wear ${itemName}`,
              styledLabel: [
                { text: "Wear " },
                { text: itemName, color: CONTEXT_MENU_COLORS.ITEM },
              ],
              enabled: true,
            });
          }

          // Fallback adds Use/Drop/Examine if not in manifest
          menuItems.push({
            id: "use",
            label: `Use ${itemName}`,
            styledLabel: [
              { text: "Use " },
              { text: itemName, color: CONTEXT_MENU_COLORS.ITEM },
            ],
            enabled: true,
          });
          menuItems.push({
            id: "drop",
            label: `Drop ${itemName}`,
            styledLabel: [
              { text: "Drop " },
              { text: itemName, color: CONTEXT_MENU_COLORS.ITEM },
            ],
            enabled: true,
          });
          menuItems.push({
            id: "examine",
            label: `Examine ${itemName}`,
            styledLabel: [
              { text: "Examine " },
              { text: itemName, color: CONTEXT_MENU_COLORS.ITEM },
            ],
            enabled: true,
          });
        } else {
          // Noted items: Use/Drop/Examine only
          menuItems.push({
            id: "use",
            label: `Use ${itemName}`,
            styledLabel: [
              { text: "Use " },
              { text: itemName, color: CONTEXT_MENU_COLORS.ITEM },
            ],
            enabled: true,
          });
          menuItems.push({
            id: "drop",
            label: `Drop ${itemName}`,
            styledLabel: [
              { text: "Drop " },
              { text: itemName, color: CONTEXT_MENU_COLORS.ITEM },
            ],
            enabled: true,
          });
          menuItems.push({
            id: "examine",
            label: `Examine ${itemName}`,
            styledLabel: [
              { text: "Examine " },
              { text: itemName, color: CONTEXT_MENU_COLORS.ITEM },
            ],
            enabled: true,
          });
        }

        // classic MMORPG-style: Cancel is always the last option
        menuItems.push({
          id: "cancel",
          label: "Cancel",
          styledLabel: [{ text: "Cancel" }],
          enabled: true,
        });

        // Dispatch context menu event
        const evt = new CustomEvent("contextmenu", {
          detail: {
            target: {
              id: `inventory_slot_${index}`,
              type: "inventory",
              name: itemName,
            },
            mousePosition: { x: e.clientX, y: e.clientY },
            items: menuItems,
          },
        });
        window.dispatchEvent(evt);
      }}
      style={{
        // Use 'size' for 2D container queries (cqw/cqh) in responsive grid
        containerType: "size",
        // classic MMORPG-style targeting:
        // - Source item: WHITE border (the item being used)
        // - Valid targets: normal appearance, cursor indicates validity
        // - Invalid targets: normal appearance, cursor shows not-allowed
        ...slotChrome,
        opacity: isDragging ? 0.3 : slotChrome.opacity,
        borderColor: isSourceItem
          ? "rgba(255, 255, 255, 0.95)" // classic MMORPG: White border on source item
          : isOver
            ? "rgba(242, 208, 138, 0.5)" // Gold highlight when dragging over
            : isEmpty
              ? "rgba(8, 8, 10, 0.6)" // Dark border for embossed empty slots
              : isItemNoted
                ? "rgba(140, 120, 80, 0.5)" // Subtle tan border for notes
                : "rgba(10, 10, 12, 0.5)", // Dark border for embossed filled slots
        borderWidth: isSourceItem ? "2px" : "1px",
        background: isOver
          ? "rgba(183, 140, 76, 0.14)" // Bronze tint when dragging over
          : isEmpty
            ? "var(--color-slot-empty)" // Use theme slot.empty color
            : isItemNoted
              ? "linear-gradient(180deg, rgba(215, 200, 165, 0.95) 0%, rgba(235, 225, 195, 0.95) 100%)" // Parchment - lighter at bottom for emboss
              : "var(--color-slot-filled)", // Use theme slot.filled color
        boxShadow: isSourceItem
          ? "0 0 8px rgba(255, 255, 255, 0.6)" // classic MMORPG: White glow on source item
          : isOver
            ? "inset 0 0 8px rgba(183, 140, 76, 0.24), 0 0 0 1px rgba(183, 140, 76, 0.12)"
            : isEmpty
              ? "inset 2px 2px 4px rgba(0, 0, 0, 0.42), inset -1px -1px 2px rgba(88, 74, 56, 0.12)" // Strong emboss for empty
              : isItemNoted
                ? "inset 1px 1px 3px rgba(0, 0, 0, 0.25), inset -1px -1px 1px rgba(255, 255, 255, 0.4)" // Subtle paper emboss
                : "inset 2px 2px 4px rgba(0, 0, 0, 0.34), inset -1px -1px 2px rgba(98, 82, 60, 0.1)", // Emboss for filled
        // classic MMORPG-style cursor changes during targeting mode
        cursor: isTargetingActive
          ? isSourceItem
            ? "default" // Source item - no special cursor
            : isValidTarget
              ? "cell" // Valid target - crosshair-like cursor
              : "not-allowed" // Invalid target - red circle with line
          : isEmpty
            ? "default"
            : isDragging
              ? "grabbing"
              : "grab",
        borderRadius: 4,
      }}
    >
      {/* Item Icon - Centered and scaled to fit slot */}
      {/* BANK NOTE SYSTEM: Darker icon for noted items (light background) */}
      {!isEmpty && (
        <div
          className="absolute inset-0 flex items-center justify-center transition-transform duration-150 group-hover:scale-110"
          style={{
            color: isItemNoted
              ? "rgba(80, 60, 40, 0.95)" // Dark brown for notes (on parchment)
              : "#f2d08a", // Gold for normal items (matches BANK_THEME.TEXT_GOLD)
            filter: isItemNoted
              ? "drop-shadow(0 1px 1px rgba(255, 255, 255, 0.3))"
              : "drop-shadow(0 2px 2px rgba(0, 0, 0, 0.6))",
            // Scale icon based on container size (uses min of width/height for square-ish behavior)
            fontSize: "clamp(14px, min(50cqw, 50cqh), 28px)",
          }}
        >
          <ItemIcon itemId={item.itemId} size={48} />
        </div>
      )}

      {/* Quantity Badge - modern MMORPG style: top-left, yellow for stacks */}
      {/* BANK NOTE SYSTEM: Darker text with light shadow for noted items */}
      {/* Mobile: Larger text for readability (clamp(10px, 3cqw, 14px)) */}
      {item &&
        item.quantity > 1 &&
        (() => {
          const { text, color } = formatQuantity(item.quantity);
          return (
            <div
              className="absolute top-0.5 left-0.5 font-bold leading-none z-10"
              style={{
                color: isItemNoted ? "#4a3520" : color, // Dark brown for notes
                // Scale text based on container size - larger on mobile for readability
                fontSize: "clamp(10px, min(24cqw, 28cqh), 14px)",
                textShadow: isItemNoted
                  ? "0 0 2px rgba(255, 255, 255, 0.8), 1px 1px 1px rgba(255, 255, 255, 0.5)"
                  : "1px 1px 1px rgba(0, 0, 0, 0.9), -1px -1px 1px rgba(0, 0, 0, 0.5)",
              }}
            >
              {text}
            </div>
          );
        })()}

      {/* Noted-item marker (bank note indicator) */}
      {item && isItemNoted && (
        <div
          className="absolute top-0.5 right-0.5 font-bold leading-none z-10"
          style={{
            color: "#4a3520",
            fontSize: "clamp(9px, min(20cqw, 22cqh), 12px)",
            textShadow:
              "0 0 2px rgba(255, 255, 255, 0.85), 1px 1px 1px rgba(255, 255, 255, 0.55)",
          }}
        >
          N
        </div>
      )}

      {/* Subtle hover highlight - embossed style glow */}
      {!isEmpty && (
        <div
          className="absolute inset-0 rounded-sm opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(183, 140, 76, 0.14) 0%, transparent 70%)",
            boxShadow: "inset 0 0 4px rgba(183, 140, 76, 0.16)",
          }}
        />
      )}
    </button>
  );
});

/**
 * Pending move operation for rollback tracking
 */
interface PendingMove {
  fromSlot: number;
  toSlot: number;
  timestamp: number;
  preMoveSlotsSnapshot: (InventorySlotViewItem | null)[];
}

/**
 * Targeting mode state for "Use X on Y" interactions (firemaking, cooking)
 * classic MMORPG-style: source item gets white border, cursor changes for valid/invalid targets
 */
interface TargetingState {
  active: boolean;
  sourceItem: { id: string; slot: number; name?: string } | null;
  validTargetIds: Set<string>;
  actionType: "firemaking" | "cooking" | "none";
}

/**
 * Hover state for "Use X → Y" tooltip (classic MMORPG-style)
 */
interface TargetHoverState {
  targetName: string;
  position: { x: number; y: number };
}

/**
 * Hover state for modern MMORPG-style item tooltip
 */
interface ItemHoverState {
  item: InventorySlotViewItem;
  position: { x: number; y: number };
}

// Tooltip positioning uses shared calculateCursorTooltipPosition utility

import type { Theme } from "@/ui";

/**
 * Render item hover tooltip content
 * Extracted from IIFE for better readability and testability
 */
function renderItemHoverTooltip(
  itemHover: ItemHoverState,
  theme: Theme,
): React.ReactNode {
  const hoveredItemData = getItem(itemHover.item.itemId);
  const itemName = hoveredItemData?.name || itemHover.item.itemId;
  const bonuses = hoveredItemData?.bonuses;
  const hasBonuses =
    bonuses &&
    ((bonuses.attack !== undefined && bonuses.attack !== 0) ||
      (bonuses.defense !== undefined && bonuses.defense !== 0) ||
      (bonuses.strength !== undefined && bonuses.strength !== 0));

  return (
    <CursorTooltip
      visible={true}
      position={itemHover.position}
      estimatedSize={TOOLTIP_SIZE_ESTIMATES.medium}
      style={{
        zIndex: zIndex.tooltip,
        minWidth: "120px",
        maxWidth: "220px",
      }}
    >
      {/* Item name */}
      <div
        style={{
          ...getTooltipTitleStyle(theme),
          marginBottom: hasBonuses ? "6px" : "0",
        }}
      >
        {itemName}
        {itemHover.item.quantity > 1 && (
          <span
            style={{
              ...getTooltipMetaStyle(theme),
              fontWeight: "normal",
            }}
          >
            {" "}
            x{itemHover.item.quantity.toLocaleString()}
          </span>
        )}
      </div>

      {/* Bonuses (for equipment) */}
      {hasBonuses && (
        <div style={getTooltipDividerStyle(theme)}>
          {bonuses.attack !== undefined && bonuses.attack !== 0 && (
            <div style={getTooltipBodyStyle(theme)}>
              ⚔️ Attack:{" "}
              <span style={{ color: theme.colors.state.success }}>
                +{bonuses.attack}
              </span>
            </div>
          )}
          {bonuses.defense !== undefined && bonuses.defense !== 0 && (
            <div style={getTooltipBodyStyle(theme)}>
              🛡️ Defense:{" "}
              <span style={{ color: theme.colors.state.success }}>
                +{bonuses.defense}
              </span>
            </div>
          )}
          {bonuses.strength !== undefined && bonuses.strength !== 0 && (
            <div style={getTooltipBodyStyle(theme)}>
              💪 Strength:{" "}
              <span style={{ color: theme.colors.state.success }}>
                +{bonuses.strength}
              </span>
            </div>
          )}
        </div>
      )}
    </CursorTooltip>
  );
}

const initialTargetingState: TargetingState = {
  active: false,
  sourceItem: null,
  validTargetIds: new Set(),
  actionType: "none",
};

export function InventoryPanel({
  items,
  coins,
  world,
  onItemMove,
  onItemUse: _onItemUse,
  onItemEquip: _onItemEquip,
  embeddedMode = null,
  onEmbeddedClick,
  onEmbeddedContextMenu,
  showCoinPouch = true,
  footerHint,
  /** When true, uses parent DndProvider context (for cross-panel drag-drop) */
  useParentDndContext = false,
}: InventoryPanelProps & { useParentDndContext?: boolean }) {
  const theme = useThemeStore((s) => s.theme);
  const { shouldUseMobileUI } = useMobileLayout();

  // Configure sensors for accessibility and mobile support
  // PointerSensor: distance-based for mouse, TouchSensor: delay-based for mobile long-press
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px movement before drag starts
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250, // Long-press 250ms to start drag on mobile
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor),
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragSlotSize, setDragSlotSize] = useState<number | null>(null);
  const [slotItems, setSlotItems] = useState<(InventorySlotViewItem | null)[]>(
    [],
  );

  // Targeting mode state for "Use X on Y" interactions
  const [targetingState, setTargetingState] = useState<TargetingState>(
    initialTargetingState,
  );

  // classic MMORPG-style hover tooltip state for "Use X → Y"
  const [targetHover, setTargetHover] = useState<TargetHoverState | null>(null);

  // modern MMORPG-style hover tooltip state for item stats
  const [itemHover, setItemHover] = useState<ItemHoverState | null>(null);

  // Track if context menu is open (suppress hover tooltips while open)
  const { isContextMenuOpen, setContextMenuOpen } = useContextMenuState();

  // Coin withdrawal modal state (for withdrawing from money pouch to inventory)
  const [coinModal, setCoinModal] = useState<{
    visible: boolean;
    action: "withdraw";
    maxAmount: number;
  }>({
    visible: false,
    action: "withdraw",
    maxAmount: 0,
  });

  // Track pending move for rollback detection
  // If server update arrives and doesn't match our optimistic state, we know it was rejected
  const pendingMoveRef = useRef<PendingMove | null>(null);

  // Track if we should skip the next props update (to avoid flickering during optimistic update)
  const skipNextPropsUpdateRef = useRef(false);

  // Ref to access current slotItems in effects without causing re-renders
  // This prevents infinite loops when useEffect both reads and writes slotItems
  const slotItemsRef = useRef<(InventorySlotViewItem | null)[]>([]);
  slotItemsRef.current = slotItems;

  // Drag sensors are handled internally with useDraggable
  // MouseSensor: 3px threshold, TouchSensor: handled via pointer events

  useEffect(() => {
    const onCtxSelect = (evt: Event) => {
      const ce = evt as CustomEvent<{
        actionId: string;
        targetId: string;
        position?: { x: number; y: number };
      }>;
      const target = ce.detail?.targetId || "";
      if (!target.startsWith("inventory_slot_")) return;
      const slotIndex = parseInt(target.replace("inventory_slot_", ""), 10);
      if (Number.isNaN(slotIndex)) return;
      const it = slotItems[slotIndex];
      if (!it || !world) return;

      // Dispatch action through centralized handler
      dispatchInventoryAction(ce.detail.actionId, {
        world,
        itemId: it.itemId,
        slot: slotIndex,
        quantity: it.quantity || 1,
      });
    };
    window.addEventListener("contextmenu:select", onCtxSelect as EventListener);
    return () =>
      window.removeEventListener(
        "contextmenu:select",
        onCtxSelect as EventListener,
      );
  }, [slotItems, world]);

  // Listen for targeting mode events (classic MMORPG-style "Use X on Y")
  useEffect(() => {
    if (!world) return;

    const onTargetingStart = (data: {
      sourceItem: { id: string; slot: number; name?: string };
      validTargetTypes: string[];
      validTargetIds: string[];
      actionType: "firemaking" | "cooking" | "none";
    }) => {
      const validIds = new Set(data.validTargetIds);
      setTargetingState({
        active: true,
        sourceItem: data.sourceItem,
        validTargetIds: validIds,
        actionType: data.actionType,
      });
    };

    const onTargetingComplete = () => {
      setTargetingState(initialTargetingState);
      setTargetHover(null); // Clear tooltip
    };

    const onTargetingCancel = () => {
      setTargetingState(initialTargetingState);
      setTargetHover(null); // Clear tooltip
    };

    // Escape key to cancel targeting mode
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && targetingState.active) {
        const localPlayer = world.getPlayer();
        if (localPlayer) {
          world.emit(EventType.TARGETING_CANCEL, { playerId: localPlayer.id });
        }
        setTargetingState(initialTargetingState);
      }
    };

    world.on(
      EventType.TARGETING_START,
      onTargetingStart as (...args: unknown[]) => void,
    );
    world.on(
      EventType.TARGETING_COMPLETE,
      onTargetingComplete as (...args: unknown[]) => void,
    );
    world.on(
      EventType.TARGETING_CANCEL,
      onTargetingCancel as (...args: unknown[]) => void,
    );
    window.addEventListener("keydown", onKeyDown);

    return () => {
      world.off(
        EventType.TARGETING_START,
        onTargetingStart as (...args: unknown[]) => void,
      );
      world.off(
        EventType.TARGETING_COMPLETE,
        onTargetingComplete as (...args: unknown[]) => void,
      );
      world.off(
        EventType.TARGETING_CANCEL,
        onTargetingCancel as (...args: unknown[]) => void,
      );
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [world, targetingState.active]);

  useEffect(() => {
    // If we have a pending move and server sent an update, check if move was accepted
    const pending = pendingMoveRef.current;

    // Skip update if we just did an optimistic update (prevents flicker)
    if (skipNextPropsUpdateRef.current) {
      skipNextPropsUpdateRef.current = false;

      // But still clear pending move after a timeout if server hasn't responded
      // This handles cases where server silently accepts (no explicit confirmation)
      if (pending) {
        const timeSinceMove = Date.now() - pending.timestamp;
        if (timeSinceMove > 500) {
          // Server update arrived, assume move was accepted
          pendingMoveRef.current = null;
        }
      }
      return;
    }

    const newSlots: (InventorySlotViewItem | null)[] =
      Array(MAX_SLOTS).fill(null);
    items.forEach((item) => {
      const s = (item as { slot?: number }).slot;
      if (typeof s === "number" && s >= 0 && s < MAX_SLOTS) {
        newSlots[s] = item;
      }
    });

    // If we have a pending move, check if server state matches our optimistic state
    if (pending) {
      const fromItem = newSlots[pending.fromSlot];
      const toItem = newSlots[pending.toSlot];
      // Use ref to access current slotItems without adding to dependencies (avoids infinite loop)
      const currentSlots = slotItemsRef.current;
      const expectedFromItem = currentSlots[pending.toSlot]; // What we moved FROM the toSlot
      const expectedToItem = currentSlots[pending.fromSlot]; // What we moved TO the fromSlot

      // Check if the swap was reflected in server state
      const fromMatches =
        (fromItem === null && expectedFromItem === null) ||
        fromItem?.itemId === expectedFromItem?.itemId;
      const toMatches =
        (toItem === null && expectedToItem === null) ||
        toItem?.itemId === expectedToItem?.itemId;

      if (!fromMatches || !toMatches) {
        // Server state doesn't match - move was rejected, server's state takes precedence
        // The newSlots from server IS the rollback
        const localPlayerId = world?.getPlayer?.()?.id;
        if (world?.emit && localPlayerId) {
          world.emit(EventType.UI_MESSAGE, {
            playerId: localPlayerId,
            message: "Move rejected by server",
            type: "error",
          });
        }
      }

      pendingMoveRef.current = null;
    }

    setSlotItems(newSlots);
  }, [items, world]);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
    // Capture the original slot size so DragOverlay matches exactly
    if (event.active.rect?.current?.initial) {
      setDragSlotSize(event.active.rect.current.initial.width);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setDragSlotSize(null);

    if (!over) return;

    // Draggable IDs: "inventory-{index}"
    // Droppable IDs: "inventory-drop-{index}"
    const fromIndex = parseInt((active.id as string).replace("inventory-", ""));
    const overId = over.id as string;
    const toIndex = overId.startsWith("inventory-drop-")
      ? parseInt(overId.replace("inventory-drop-", ""))
      : parseInt(overId.replace("inventory-", ""));

    // Don't swap with self
    if (fromIndex === toIndex) return;

    // Store pre-move state for potential rollback
    pendingMoveRef.current = {
      fromSlot: fromIndex,
      toSlot: toIndex,
      timestamp: Date.now(),
      preMoveSlotsSnapshot: [...slotItems],
    };

    // classic MMORPG-style SWAP: exchange two slots directly (don't shift/insert)
    // Create deep copies of items to avoid mutating props and update .slot property
    const newSlots = [...slotItems];
    const fromItem = newSlots[fromIndex];
    const toItem = newSlots[toIndex];

    // Update .slot property on copies to match new positions
    // This ensures consistency when useEffect rebuilds from items prop
    if (fromItem) {
      newSlots[toIndex] = { ...fromItem, slot: toIndex };
    } else {
      newSlots[toIndex] = null;
    }
    if (toItem) {
      newSlots[fromIndex] = { ...toItem, slot: fromIndex };
    } else {
      newSlots[fromIndex] = null;
    }

    // Mark that we just did optimistic update (skip next props sync to prevent flicker)
    skipNextPropsUpdateRef.current = true;
    setSlotItems(newSlots);

    if (onItemMove) {
      onItemMove(fromIndex, toIndex);
    }

    // Clear pending move after timeout if server doesn't respond
    // This handles the case where move is accepted but server doesn't send explicit update
    // Capture timestamp in closure to handle multiple rapid moves correctly
    const moveTimestamp = pendingMoveRef.current.timestamp;
    setTimeout(() => {
      // Only clear if this specific move is still pending (not a newer move)
      if (pendingMoveRef.current?.timestamp === moveTimestamp) {
        pendingMoveRef.current = null;
      }
    }, 2000);
  };

  // Memoized handlers to prevent unnecessary re-renders of child components
  const handleTargetClick = useCallback(
    (clickedItem: InventorySlotViewItem, slotIndex: number) => {
      // Handle targeting mode click - emit TARGETING_SELECT event
      if (targetingState.active && targetingState.sourceItem) {
        const localPlayer = world?.getPlayer();
        if (localPlayer) {
          // Clear hover tooltip before action
          setTargetHover(null);
          world?.emit(EventType.TARGETING_SELECT, {
            playerId: localPlayer.id,
            sourceItemId: targetingState.sourceItem.id,
            sourceSlot: targetingState.sourceItem.slot,
            targetId: clickedItem.itemId,
            targetType: "inventory_item",
            targetSlot: slotIndex,
          });
          // Clear targeting immediately — action is committed
          setTargetingState(initialTargetingState);
        }
      }
    },
    [world, targetingState.active, targetingState.sourceItem],
  );

  const handleTargetHover = useCallback(
    (
      hoveredItem: InventorySlotViewItem,
      position: { x: number; y: number },
    ) => {
      // classic MMORPG-style "Use X → Y" tooltip
      setTargetHover({
        targetName: hoveredItem.itemId,
        position,
      });
    },
    [],
  );

  const handleTargetHoverEnd = useCallback(() => {
    setTargetHover(null);
  }, []);

  // modern MMORPG-style item hover handlers for stats tooltip
  const handleItemHoverStart = useCallback(
    (item: InventorySlotViewItem, position: { x: number; y: number }) => {
      // Don't show hover tooltip if context menu is open
      if (isContextMenuOpen) return;
      setItemHover({ item, position });
    },
    [isContextMenuOpen],
  );

  const handleItemHoverMove = useCallback(
    (position: { x: number; y: number }) => {
      // Don't update hover tooltip if context menu is open
      if (isContextMenuOpen) return;
      setItemHover((prev) => (prev ? { ...prev, position } : null));
    },
    [isContextMenuOpen],
  );

  const handleItemHoverEnd = useCallback(() => {
    setItemHover(null);
  }, []);

  const handleContextMenuOpen = useCallback(() => {
    setContextMenuOpen(true);
  }, [setContextMenuOpen]);

  // Coin pouch withdrawal modal handlers
  const openCoinModal = useCallback(() => {
    if (coins > 0) {
      setCoinModal({ visible: true, action: "withdraw", maxAmount: coins });
    }
  }, [coins]);

  const closeCoinModal = useCallback(() => {
    setCoinModal((prev) => ({ ...prev, visible: false }));
  }, []);

  const handleCoinWithdraw = useCallback(
    (amount: number) => {
      if (!world?.network?.send) return;
      world.network.send("coinPouchWithdraw", {
        amount,
        timestamp: Date.now(), // Replay attack protection
      });
      closeCoinModal();
    },
    [world, closeCoinModal],
  );

  const handleInvalidTargetClick = useCallback(() => {
    // classic MMORPG: "Nothing interesting happens." when using item on invalid target
    const message = "Nothing interesting happens.";

    // Show in chat (classic MMORPG-style game message)
    if (world?.chat?.add) {
      world.chat.add({
        id: uuid(),
        from: "",
        body: message,
        createdAt: new Date().toISOString(),
        timestamp: Date.now(),
      });
    }

    // Cancel targeting mode
    setTargetingState(initialTargetingState);
    setTargetHover(null);
  }, [world]);

  const handlePrimaryAction = useCallback(
    (
      clickedItem: InventorySlotViewItem,
      slotIndex: number,
      actionType: PrimaryActionType,
    ) => {
      if (!world) return;

      // Dispatch through centralized handler
      dispatchInventoryAction(actionType, {
        world,
        itemId: clickedItem.itemId,
        slot: slotIndex,
        quantity: clickedItem.quantity || 1,
      });
    },
    [world],
  );

  const handleShiftClick = useCallback(
    (clickedItem: InventorySlotViewItem, slotIndex: number) => {
      if (!world) return;
      dispatchInventoryAction("drop", {
        world,
        itemId: clickedItem.itemId,
        slot: slotIndex,
        quantity: clickedItem.quantity || 1,
      });
    },
    [world],
  );

  // When using parent context, use the global drag store to get the active item
  const dragStoreItem = useDragStore((state) => state.item);
  const isDragging = useDragStore((state) => state.isDragging);

  // Determine active item: use local state if not using parent context,
  // otherwise use the global drag store
  const activeItem = useMemo(() => {
    if (useParentDndContext) {
      // Using parent context - check global drag store
      if (
        isDragging &&
        dragStoreItem?.id?.toString().startsWith("inventory-")
      ) {
        const index = parseInt(
          dragStoreItem.id.toString().replace("inventory-", ""),
          10,
        );
        return slotItems[index] ?? null;
      }
      return null;
    }
    // Using local DndProvider
    return activeId ? slotItems[parseInt(activeId.split("-")[1])] : null;
  }, [useParentDndContext, isDragging, dragStoreItem?.id, slotItems, activeId]);

  // The inventory content - grid, coins, and drag overlay
  const inventoryContent = (
    <div
      className="flex flex-col h-full overflow-hidden gap-1"
      style={{
        ...getPanelSurfaceStyle(theme, { emphasis: "normal" }),
        minHeight: 0,
        padding: shouldUseMobileUI ? "4px" : `${theme.spacing.xs}px`,
        border: "none",
        borderRadius: 0,
        boxShadow: "none",
      }}
    >
      {/* classic MMORPG-style "Use X → Y" tooltip - rendered via portal to avoid transform issues */}
      {targetingState.active &&
        targetHover &&
        targetingState.sourceItem &&
        createPortal(
          <div
            className="pointer-events-none px-2 py-1 text-sm font-medium whitespace-nowrap"
            style={{
              position: "fixed",
              // Position tooltip close to cursor (4px offset)
              left: targetHover.position.x + 4,
              top: targetHover.position.y + 4,
              zIndex: zIndex.tooltip,
              background: "rgba(0, 0, 0, 0.85)",
              border: "1px solid rgba(180, 160, 100, 0.8)",
              borderRadius: "2px",
              color: "rgba(255, 200, 100, 0.95)",
              textShadow: "1px 1px 0 #000",
              boxShadow: "2px 2px 4px rgba(0, 0, 0, 0.5)",
            }}
          >
            Use {targetingState.sourceItem.name || targetingState.sourceItem.id}{" "}
            → {targetHover.targetName}
          </div>,
          document.body,
        )}

      {/* modern MMORPG-style item hover tooltip - rendered via portal */}
      {!targetingState.active &&
        itemHover &&
        renderItemHoverTooltip(itemHover, theme)}

      {/* Inventory Grid - Desktop: 4×7, Mobile: 4×7 (28 total slots) */}
      {/* Uses CSS grid with flexible sizing - slots scale with panel dimensions */}
      <div
        className="border rounded overflow-hidden flex-1"
        style={{
          ...getPanelInsetStyle(theme, {
            emphasis: "strong",
            radius: theme.borderRadius.md,
          }),
          // Container query support for responsive slot sizing
          containerType: "size",
          minHeight: 0,
          padding: shouldUseMobileUI ? "3px" : "4px",
        }}
      >
        <div
          className="grid h-full w-full"
          style={{
            // Both mobile and desktop: 4 columns × 7 rows (classic MMORPG style)
            gridTemplateColumns: "repeat(4, 1fr)",
            gridTemplateRows: "repeat(7, 1fr)",
            // Mobile: tighter gap, Desktop: scales with container
            gap: shouldUseMobileUI ? "2px" : "clamp(2px, 0.5cqw, 3px)",
            padding: shouldUseMobileUI ? "2px" : "clamp(2px, 0.5cqw, 3px)",
          }}
        >
          {slotItems.map((item, index) => (
            <DraggableInventorySlot
              key={
                item?.itemId ? `${item.slot}-${item.itemId}` : `empty-${index}`
              }
              item={item}
              index={index}
              targetingState={embeddedMode ? undefined : targetingState}
              onTargetClick={embeddedMode ? undefined : handleTargetClick}
              onTargetHover={embeddedMode ? undefined : handleTargetHover}
              onTargetHoverEnd={embeddedMode ? undefined : handleTargetHoverEnd}
              onInvalidTargetClick={
                embeddedMode ? undefined : handleInvalidTargetClick
              }
              onPrimaryAction={embeddedMode ? undefined : handlePrimaryAction}
              onShiftClick={embeddedMode ? undefined : handleShiftClick}
              onItemHoverStart={handleItemHoverStart}
              onItemHoverMove={handleItemHoverMove}
              onItemHoverEnd={handleItemHoverEnd}
              onContextMenuOpen={handleContextMenuOpen}
              embeddedMode={embeddedMode}
              onEmbeddedClick={onEmbeddedClick}
              onEmbeddedContextMenu={onEmbeddedContextMenu}
            />
          ))}
        </div>
      </div>

      {/* modern MMORPG-style Coins/Money Pouch - Extracted component */}
      {showCoinPouch && (
        <CoinPouch coins={coins} onWithdrawClick={openCoinModal} />
      )}

      {/* Footer hint for embedded mode */}
      {footerHint && (
        <div
          className="px-2 py-1 text-center"
          style={{
            ...getPanelInsetStyle(theme, {
              emphasis: "normal",
              radius: theme.borderRadius.sm,
              padding: 0,
            }),
            borderTop: `1px solid ${theme.colors.border.default}55`,
            borderRadius: `${theme.borderRadius.sm}px`,
          }}
        >
          <span
            className="text-[10px]"
            style={{ color: theme.colors.text.muted }}
          >
            {footerHint}
          </span>
        </div>
      )}

      <DragOverlay>
        {activeItem
          ? (() => {
              const qtyDisplay =
                activeItem.quantity > 1
                  ? formatQuantity(activeItem.quantity)
                  : null;
              return (
                <div
                  className="border rounded flex items-center justify-center aspect-square relative"
                  style={{
                    width: dragSlotSize ?? 40, // Use captured slot size, fallback to 40px
                    height: dragSlotSize ?? 40,
                    borderColor: `${theme.colors.accent.secondary}99`,
                    background: `linear-gradient(180deg, rgba(255, 255, 255, 0.07) 0%, ${theme.colors.accent.secondary}18 22%, rgba(24, 28, 34, 0.98) 100%)`,
                    fontSize: dragSlotSize ? `${dragSlotSize * 0.4}px` : "1rem", // Scale icon with slot
                    color: theme.colors.text.accent,
                    boxShadow: theme.shadows.lg,
                  }}
                >
                  <ItemIcon
                    itemId={activeItem.itemId}
                    size={dragSlotSize ? dragSlotSize * 0.85 : 36}
                  />
                  {qtyDisplay && (
                    <div
                      className="absolute bottom-0.5 right-0.5 font-bold rounded px-0.5 py-0.5 leading-none"
                      style={{
                        background: theme.colors.background.overlay,
                        color: qtyDisplay.color,
                        fontSize: dragSlotSize
                          ? `${dragSlotSize * 0.18}px`
                          : "0.4rem", // Scale with slot
                        textShadow: "1px 1px 1px rgba(0, 0, 0, 0.8)",
                      }}
                    >
                      {qtyDisplay.text}
                    </div>
                  )}
                </div>
              );
            })()
          : null}
      </DragOverlay>
    </div>
  );

  return (
    <>
      {/* When using parent context, don't wrap with DndProvider */}
      {useParentDndContext ? (
        inventoryContent
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          {inventoryContent}
        </DndContext>
      )}

      {/* Coin Withdrawal Modal */}
      <CoinAmountModal
        modal={coinModal}
        onConfirm={handleCoinWithdraw}
        onClose={closeCoinModal}
      />
    </>
  );
}
