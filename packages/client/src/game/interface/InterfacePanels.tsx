/**
 * Interface Panels
 *
 * Window content helper components for InterfaceManager including:
 * - WindowContent
 * - DraggableContentWrapper
 * - ActionBarWrapper
 * - MenuBarWrapper
 * - MinimapWrapper
 *
 * @packageDocumentation
 */

import React from "react";
import {
  useTabDrag,
  useDrop,
  useDragStore,
  useWindowStore,
  useTheme,
} from "@/ui";
import type {
  WindowContentProps,
  DraggableContentWrapperProps,
  ActionBarWrapperProps,
  MenuBarWrapperProps,
  MinimapWrapperProps,
} from "./types";
import { Minimap } from "../hud/Minimap";
import { MinimapOverlayControls } from "../hud/MinimapOverlayControls";

/**
 * WindowContent - Renders the active tab content
 */
export function WindowContent({
  activeTabIndex,
  tabs,
  renderPanel,
  windowId,
}: WindowContentProps): React.ReactElement | null {
  const activeTab = tabs[activeTabIndex];

  if (!activeTab) return null;

  // Component fills available space, panels handle their own scrolling
  // Multi-tab windows use TabBar for drop zones, not the content area
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
        position: "relative",
      }}
    >
      {tabs.map((tab, idx) => {
        const isActive = idx === activeTabIndex;
        const panelContent =
          typeof tab.content === "string"
            ? renderPanel(tab.content, undefined, windowId)
            : tab.content;

        const isActionBar =
          typeof tab.content === "string" &&
          tab.content.startsWith("actionbar-");

        return (
          <div
            key={tab.id || idx}
            style={{
              display: isActive ? "flex" : "none",
              position: "absolute",
              inset: 0,
              flexDirection: "column",
              padding: isActionBar ? 0 : 4,
              overflow: "hidden",
            }}
          >
            {panelContent}
          </div>
        );
      })}
    </div>
  );
}

/**
 * DraggableContentWrapper - Single-tab windows with draggable header
 */
export function DraggableContentWrapper({
  windowId,
  activeTabIndex,
  tabs,
  renderPanel,
  dragHandleProps,
  isUnlocked,
}: DraggableContentWrapperProps): React.ReactElement | null {
  const activeTab = tabs[activeTabIndex];
  const { mergeWindow, moveTab, isTabDragging, draggingSourceWindowId } =
    useTabDrag();
  const theme = useTheme();

  // Check if a window is being dragged (for window-to-window merge)
  const isDragging = useDragStore((s) => s.isDragging);
  const dragItem = useDragStore((s) => s.item);
  const isWindowDragging = isDragging && dragItem?.type === "window";
  const draggingWindowId = isWindowDragging ? dragItem?.id : null;

  // Get the dragged tab/window info for preview (icon and label)
  const draggedTabInfo = React.useMemo(() => {
    if (!dragItem) return null;
    if (dragItem.type === "tab") {
      const sourceWindowId = dragItem.sourceId;
      if (sourceWindowId) {
        const sourceWindow = useWindowStore
          .getState()
          .getWindow(sourceWindowId);
        const tab = sourceWindow?.tabs.find((t) => t.id === dragItem.id);
        return { label: tab?.label || dragItem.id, icon: tab?.icon };
      }
    } else if (dragItem.type === "window") {
      const sourceWindow = useWindowStore.getState().getWindow(dragItem.id);
      return {
        label: sourceWindow?.tabs[0]?.label || dragItem.id,
        icon: sourceWindow?.tabs[0]?.icon,
      };
    }
    return null;
  }, [dragItem]);

  // Show merge zone when dragging a tab or window from another window
  const isDraggingFromOther =
    (isTabDragging && draggingSourceWindowId !== windowId) ||
    (isWindowDragging && draggingWindowId !== windowId);
  const showMergeZone = isUnlocked && isDraggingFromOther;

  // Header drop zone - only the top header area accepts drops
  const { isOver, dropProps } = useDrop({
    id: `window-header-drop-${windowId}`,
    accepts: ["tab", "window"],
    disabled: !showMergeZone,
    onDrop: (item) => {
      if (item.type === "tab") {
        if (item.sourceId && item.sourceId !== windowId) {
          moveTab(item.id, windowId);
        }
      } else if (item.type === "window") {
        if (item.id && item.id !== windowId) {
          mergeWindow(item.id, windowId);
        }
      }
    },
  });

  if (!activeTab) return null;

  // Get panel content
  const panelContent =
    typeof activeTab.content === "string"
      ? renderPanel(activeTab.content, undefined, windowId)
      : activeTab.content;

  // Header height matches TabBar
  const headerHeight = 28;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {/* Header drop zone - this is where tabs can be combined */}
      <div
        {...dropProps}
        {...(isUnlocked && dragHandleProps ? dragHandleProps : {})}
        style={{
          height: headerHeight,
          minHeight: headerHeight,
          display: "flex",
          alignItems: "center",
          backgroundColor: isOver
            ? theme.colors.accent.primary
            : theme.colors.background.secondary,
          borderBottom: `1px solid ${theme.colors.border.default}`,
          cursor: isUnlocked ? "grab" : "default",
          transition: "background-color 0.15s ease",
          overflow: "hidden",
        }}
      >
        {/* Tab preview when hovering */}
        {isOver && draggedTabInfo ? (
          // Show combined tabs preview (icons only)
          <div style={{ display: "flex", flex: 1, gap: 4, padding: "0 8px" }}>
            {/* Current tab icon */}
            <div
              style={{
                padding: "4px 8px",
                fontSize: theme.typography.fontSize.sm,
                color: theme.colors.text.primary,
                backgroundColor: theme.colors.background.tertiary,
                borderRadius: theme.borderRadius.sm,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {activeTab.icon || activeTab.label.charAt(0)}
            </div>
            {/* Incoming tab icon (preview) */}
            <div
              style={{
                padding: "4px 8px",
                fontSize: theme.typography.fontSize.sm,
                color: theme.colors.text.secondary,
                backgroundColor: theme.colors.background.secondary,
                borderRadius: theme.borderRadius.sm,
                opacity: 0.8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {draggedTabInfo.icon || draggedTabInfo.label?.charAt(0) || "+"}
            </div>
          </div>
        ) : (
          // Normal header with current tab (icon only)
          <div
            style={{
              padding: "4px 12px",
              fontSize: theme.typography.fontSize.sm,
              color: theme.colors.text.primary,
              flex: 1,
              display: "flex",
              alignItems: "center",
            }}
          >
            {activeTab.icon || activeTab.label.charAt(0)}
          </div>
        )}
      </div>
      {/* Panel content area keeps mounting all tabs to retain state */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {tabs.map((tab, idx) => {
          const isActive = idx === activeTabIndex;
          const panelContent =
            typeof tab.content === "string"
              ? renderPanel(tab.content, undefined, windowId)
              : tab.content;

          return (
            <div
              key={tab.id || idx}
              style={{
                display: isActive ? "flex" : "none",
                position: "absolute",
                inset: 0,
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              {panelContent}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * ActionBarWrapper - Makes action bar content area draggable
 */
export function ActionBarWrapper({
  activeTabIndex,
  tabs,
  renderPanel,
  dragHandleProps,
  isUnlocked,
  windowId,
}: ActionBarWrapperProps): React.ReactElement | null {
  const activeTab = tabs[activeTabIndex];
  if (!activeTab) return null;

  const panelContent =
    typeof activeTab.content === "string"
      ? renderPanel(activeTab.content, undefined, windowId)
      : activeTab.content;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "flex-start",
        cursor: isUnlocked ? "move" : "default",
        touchAction: isUnlocked ? "none" : "auto",
        overflow: "hidden",
      }}
      onPointerDown={isUnlocked ? dragHandleProps?.onPointerDown : undefined}
    >
      {panelContent}
    </div>
  );
}

/**
 * MenuBarWrapper - Makes menu bar content area draggable
 */
export function MenuBarWrapper({
  activeTabIndex,
  tabs,
  renderPanel,
  dragHandleProps,
  isUnlocked,
  windowId,
}: MenuBarWrapperProps): React.ReactElement | null {
  const activeTab = tabs[activeTabIndex];
  if (!activeTab) return null;

  const panelContent =
    typeof activeTab.content === "string"
      ? renderPanel(activeTab.content, undefined, windowId)
      : activeTab.content;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "flex-start",
        cursor: isUnlocked ? "move" : "default",
        touchAction: isUnlocked ? "none" : "auto",
        overflow: "hidden",
      }}
      onPointerDown={isUnlocked ? dragHandleProps?.onPointerDown : undefined}
    >
      {panelContent}
    </div>
  );
}

/**
 * MinimapWrapper - Wraps Minimap component for embedding in a panel
 *
 * The canvas and controls use the actual panel viewport. The saved window
 * dimensions are never changed to accommodate a square map.
 */
export function MinimapWrapper({
  world,
  dragHandleProps,
  isUnlocked,
}: MinimapWrapperProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement>(null);
  // Track the same actual viewport for both map canvases and overlay controls.
  const [containerDimensions, setContainerDimensions] = React.useState({
    width: 200,
    height: 200,
  });

  React.useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const width = Math.floor(rect.width);
        const height = Math.floor(rect.height);
        // Hidden/transitioning panels do not replace the last usable viewport.
        if (width <= 0 || height <= 0) return;

        // Update container dimensions for overlay controls
        setContainerDimensions((prev) => {
          if (prev.width !== width || prev.height !== height) {
            return { width, height };
          }
          return prev;
        });
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, []);

  // Don't render minimap if world is not available
  if (!world) {
    return (
      <div
        ref={containerRef}
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          color: "#666",
          fontSize: "12px",
        }}
      >
        Loading minimap...
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 0,
        minHeight: 0,
        overflow: "visible",
        position: "relative",
      }}
    >
      {/* Fit the real viewport; no centered square extends beyond the panel. */}
      <div
        style={{
          position: "relative",
          width: containerDimensions.width,
          height: containerDimensions.height,
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        <Minimap
          key={`minimap-${containerDimensions.width}x${containerDimensions.height}`}
          world={world}
          width={containerDimensions.width}
          height={containerDimensions.height}
          zoom={10}
          isVisible={true}
          resizable={false}
          embedded={true}
          dragHandleProps={dragHandleProps}
          isUnlocked={isUnlocked}
        />
      </div>
      {/* Overlay controls at container level, positioned over entire visible area */}
      <MinimapOverlayControls
        world={world}
        width={containerDimensions.width}
        height={containerDimensions.height}
      />
    </div>
  );
}
