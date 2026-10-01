/**
 * QuestDetailPanel - Separate window for quest details
 *
 * This panel displays detailed information about a selected quest
 * in a separate floating window, similar to the world map or character stats.
 *
 * Uses the quest selection store from @/ui to get the currently selected quest.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useQuestSelectionStore, useTheme } from "@/ui";
import {
  getInteractiveTileStyle,
  getPanelHeaderStyle,
  getPanelInsetStyle,
  getPanelSurfaceStyle,
  getShellControlButtonStyle,
} from "@/ui/theme/themes";
import {
  type Quest,
  calculateQuestProgress,
  CATEGORY_CONFIG,
} from "@/game/systems";
import { COLORS, spacing, typography } from "../../constants";
import { parseJSONWithDefault } from "../../utils/validation";
import type { ClientWorld } from "../../types";
import { useServerQuestSync } from "../systems/quest/useQuestLog";
import { canClaimQuest } from "../systems/quest/questUtils";

// ============================================================================
// Quest Detail Panel Component
// ============================================================================

interface QuestDetailPanelProps {
  world: ClientWorld;
  onClose?: () => void;
}

/** LocalStorage key for pinned quests */
const PINNED_QUESTS_KEY = "hyperia_pinned_quests";

/** Type guard for string array */
function isStringArray(data: unknown): data is string[] {
  return Array.isArray(data) && data.every((item) => typeof item === "string");
}

/** Load pinned quest IDs from localStorage with type validation */
function loadPinnedQuests(): Set<string> {
  const stored = localStorage.getItem(PINNED_QUESTS_KEY);
  if (!stored) return new Set();
  const ids = parseJSONWithDefault(stored, isStringArray, []);
  return new Set(ids);
}

/** Save pinned quest IDs to localStorage */
function savePinnedQuests(pinnedIds: Set<string>): void {
  try {
    localStorage.setItem(PINNED_QUESTS_KEY, JSON.stringify([...pinnedIds]));
  } catch {
    // Ignore storage errors
  }
}

// classic MMORPG-style status colors
const STATUS_COLORS: Record<string, string> = {
  available: COLORS.ERROR, // Red - not started
  active: COLORS.WARNING, // Yellow - in progress
  completed: COLORS.SUCCESS, // Green - complete
  failed: COLORS.TEXT_MUTED, // Gray - failed
};

/**
 * QuestDetailPanel Component
 *
 * Displays detailed quest information in a separate window.
 * Reads the selected quest from the quest selection store.
 * Auto-closes when no quest is selected - the panel should never show empty.
 */
export function QuestDetailPanel({ world, onClose }: QuestDetailPanelProps) {
  useServerQuestSync(world);
  const theme = useTheme();
  const selectedQuest = useQuestSelectionStore((s) => s.selectedQuest);
  const setSelectedQuest = useQuestSelectionStore((s) => s.setSelectedQuest);

  // Mobile responsiveness
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 640 : false,
  );

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 640);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Auto-close the panel when no quest is selected
  // The panel should never show an empty state
  // Use a small delay to ensure the window system is ready
  useEffect(() => {
    if (!selectedQuest && onClose) {
      // Small delay to ensure window is fully mounted before destroy
      const timer = setTimeout(() => {
        onClose();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [selectedQuest, onClose]);

  // Listen for pin changes from other components (e.g., QuestsPanel)
  useEffect(() => {
    const handlePinChange = (event: Event) => {
      const customEvent = event as CustomEvent<{
        questId: string;
        pinned: boolean;
      }>;
      const { questId, pinned } = customEvent.detail;
      if (
        selectedQuest &&
        selectedQuest.id === questId &&
        selectedQuest.pinned !== pinned
      ) {
        setSelectedQuest({ ...selectedQuest, pinned });
      }
    };

    window.addEventListener("questPinChanged", handlePinChange);
    return () => window.removeEventListener("questPinChanged", handlePinChange);
  }, [selectedQuest, setSelectedQuest]);

  // Quest actions
  const handleAcceptQuest = useCallback(
    (quest: Quest) => {
      world.network?.send?.("questAccept", { questId: quest.id });
    },
    [world],
  );

  const handleTogglePin = useCallback(
    (quest: Quest) => {
      // Toggle pinned state - client-side only, persisted to localStorage
      const pinnedIds = loadPinnedQuests();
      const newPinned = !pinnedIds.has(quest.id);

      if (newPinned) {
        pinnedIds.add(quest.id);
      } else {
        pinnedIds.delete(quest.id);
      }
      savePinnedQuests(pinnedIds);

      // Update the selected quest in the store with new pinned state
      setSelectedQuest({ ...quest, pinned: newPinned });

      // Dispatch custom event to notify other components (e.g., QuestsPanel)
      window.dispatchEvent(
        new CustomEvent("questPinChanged", {
          detail: { questId: quest.id, pinned: newPinned },
        }),
      );
    },
    [setSelectedQuest],
  );

  const handleClose = useCallback(() => {
    setSelectedQuest(null);
    onClose?.();
  }, [setSelectedQuest, onClose]);

  // If no quest is selected, don't render anything
  // The useEffect above will trigger onClose to destroy the window
  if (!selectedQuest) {
    return null;
  }

  const progress = calculateQuestProgress(selectedQuest);
  const categoryConfig = CATEGORY_CONFIG[selectedQuest.category];
  const canAccept = selectedQuest.state === "available";
  const canComplete = canClaimQuest(selectedQuest);
  const closeButtonStyle = getShellControlButtonStyle(theme, "danger");

  // Styles
  const containerStyle: React.CSSProperties = {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    ...getPanelSurfaceStyle(theme, { emphasis: "normal" }),
    overflow: "hidden",
  };

  const headerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: isMobile ? spacing.xs : spacing.sm,
    padding: isMobile
      ? `${spacing.sm} ${spacing.sm}`
      : `${spacing.sm} ${spacing.md}`,
    ...getPanelHeaderStyle(theme),
    minHeight: isMobile ? "48px" : "44px",
  };

  const titleStyle: React.CSSProperties = {
    flex: 1,
    color: STATUS_COLORS[selectedQuest.state] || COLORS.TEXT_PRIMARY,
    fontSize: isMobile ? typography.fontSize.lg : typography.fontSize.base,
    fontWeight: typography.fontWeight.semibold,
    margin: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    overflowY: "auto",
    padding: isMobile ? spacing.sm : spacing.md,
    WebkitOverflowScrolling: "touch",
  };

  const sectionStyle: React.CSSProperties = {
    marginBottom: isMobile ? spacing.sm : spacing.md,
    ...getPanelInsetStyle(theme, {
      emphasis: "normal",
      radius: theme.borderRadius.md,
      padding: isMobile ? spacing.sm : spacing.md,
    }),
  };

  const sectionTitleStyle: React.CSSProperties = {
    color: theme.colors.text.accent,
    fontSize: isMobile ? typography.fontSize.sm : typography.fontSize.xs,
    fontWeight: typography.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    marginBottom: spacing.xs,
  };

  const descriptionStyle: React.CSSProperties = {
    color: theme.colors.text.secondary,
    fontSize: isMobile ? typography.fontSize.base : typography.fontSize.sm,
    lineHeight: "1.5",
    margin: 0,
  };

  const metaRowStyle: React.CSSProperties = {
    display: "flex",
    flexWrap: isMobile ? "wrap" : "nowrap",
    gap: isMobile ? spacing.sm : spacing.md,
    marginBottom: isMobile ? spacing.sm : spacing.md,
    ...getPanelInsetStyle(theme, {
      emphasis: "strong",
      radius: theme.borderRadius.md,
      padding: spacing.sm,
    }),
    fontSize: isMobile ? typography.fontSize.base : typography.fontSize.sm,
  };

  const metaItemStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: isMobile ? "calc(50% - 8px)" : "auto",
  };

  const metaLabelStyle: React.CSSProperties = {
    color: theme.colors.text.muted,
    fontSize: isMobile ? typography.fontSize.sm : typography.fontSize.xs,
    textTransform: "uppercase",
  };

  const metaValueStyle: React.CSSProperties = {
    color: theme.colors.text.primary,
    fontWeight: typography.fontWeight.medium,
  };

  const progressBarContainerStyle: React.CSSProperties = {
    height: isMobile ? "6px" : "4px",
    ...getPanelInsetStyle(theme, {
      radius: 999,
    }),
    overflow: "hidden",
    marginTop: spacing.xs,
    padding: 0,
  };

  const progressBarFillStyle: React.CSSProperties = {
    height: "100%",
    width: `${progress}%`,
    backgroundColor:
      progress === 100
        ? theme.colors.state.success
        : theme.colors.accent.primary,
    transition: "width 0.3s ease",
  };

  const objectiveStyle = (completed: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "flex-start",
    gap: spacing.xs,
    padding: `${spacing.xs} 0`,
    color: completed ? theme.colors.state.success : theme.colors.text.secondary,
    fontSize: isMobile ? typography.fontSize.base : typography.fontSize.sm,
    textDecoration: completed ? "line-through" : "none",
    opacity: completed ? 0.7 : 1,
  });

  const actionsStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: isMobile ? "column" : "row",
    gap: spacing.sm,
    padding: isMobile ? spacing.sm : spacing.md,
    borderTop: `1px solid ${theme.colors.border.default}`,
    ...getPanelInsetStyle(theme, {
      emphasis: "normal",
      radius: 0,
    }),
  };

  const buttonBaseStyle: React.CSSProperties = {
    flex: isMobile ? "none" : 1,
    padding: isMobile
      ? `${spacing.md} ${spacing.md}`
      : `${spacing.sm} ${spacing.md}`,
    border: "none",
    borderRadius: "6px",
    fontSize: isMobile ? typography.fontSize.base : typography.fontSize.sm,
    fontWeight: typography.fontWeight.medium,
    cursor: "pointer",
    transition: "all 0.15s ease",
    minHeight: isMobile ? "44px" : "auto",
  };

  const primaryButtonStyle: React.CSSProperties = {
    ...buttonBaseStyle,
    ...getInteractiveTileStyle(theme, {
      active: true,
      accentColor: theme.colors.accent.primary,
      radius: theme.borderRadius.md,
    }),
    color: theme.colors.text.primary,
  };

  const secondaryButtonStyle: React.CSSProperties = {
    ...buttonBaseStyle,
    ...getInteractiveTileStyle(theme, {
      radius: theme.borderRadius.md,
    }),
    color: theme.colors.text.primary,
  };

  return (
    <div style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <h3 style={titleStyle}>
          {selectedQuest.pinned && (
            <span
              style={{ color: theme.colors.accent.gold, marginRight: "6px" }}
              title="Pinned"
            >
              ★
            </span>
          )}
          {selectedQuest.title}
        </h3>
        <button
          onClick={handleClose}
          style={{
            ...closeButtonStyle,
            fontSize: typography.fontSize.lg,
            padding: spacing.xs,
            lineHeight: 1,
          }}
          title="Close"
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = String(
              closeButtonStyle["--shell-button-hover-bg"],
            );
            e.currentTarget.style.color = String(
              closeButtonStyle["--shell-button-hover-fg"],
            );
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = String(
              closeButtonStyle.background,
            );
            e.currentTarget.style.color = String(closeButtonStyle.color);
          }}
        >
          ✕
        </button>
      </div>

      {/* Content */}
      <div style={contentStyle} className="scrollbar-thin">
        {/* Meta info */}
        <div style={metaRowStyle}>
          <div style={metaItemStyle}>
            <span style={metaLabelStyle}>Category</span>
            <span style={{ ...metaValueStyle, color: categoryConfig.color }}>
              {categoryConfig.icon} {categoryConfig.label}
            </span>
          </div>
          <div style={metaItemStyle}>
            <span style={metaLabelStyle}>Level</span>
            <span style={metaValueStyle}>{selectedQuest.level || 1}</span>
          </div>
          <div style={metaItemStyle}>
            <span style={metaLabelStyle}>Status</span>
            <span
              style={{
                ...metaValueStyle,
                color: STATUS_COLORS[selectedQuest.state],
              }}
            >
              {selectedQuest.state.charAt(0).toUpperCase() +
                selectedQuest.state.slice(1)}
            </span>
          </div>
          {selectedQuest.state === "active" && (
            <div style={metaItemStyle}>
              <span style={metaLabelStyle}>Progress</span>
              <span style={metaValueStyle}>{progress}%</span>
            </div>
          )}
        </div>

        {/* Progress bar for active quests */}
        {selectedQuest.state === "active" && (
          <div style={progressBarContainerStyle}>
            <div style={progressBarFillStyle} />
          </div>
        )}

        {/* Description */}
        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>Description</div>
          <p style={descriptionStyle}>{selectedQuest.description}</p>
        </div>

        {/* Objectives */}
        {selectedQuest.objectives && selectedQuest.objectives.length > 0 && (
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Objectives</div>
            {selectedQuest.objectives.map((obj) => {
              const isComplete = obj.current >= obj.target;
              return (
                <div key={obj.id} style={objectiveStyle(isComplete)}>
                  <span>{isComplete ? "✓" : "○"}</span>
                  <span>
                    {obj.description}
                    {obj.target > 1 && ` (${obj.current}/${obj.target})`}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Rewards */}
        {selectedQuest.rewards && selectedQuest.rewards.length > 0 && (
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Rewards</div>
            {selectedQuest.rewards.map((reward, idx) => (
              <div
                key={idx}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.xs,
                  padding: `${spacing.xs} 0`,
                  color: theme.colors.text.secondary,
                  fontSize: isMobile
                    ? typography.fontSize.base
                    : typography.fontSize.sm,
                }}
              >
                <span>{reward.icon || "•"}</span>
                <span>
                  {reward.amount ? `${reward.amount} ` : ""}
                  {reward.name}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Quest giver info */}
        {selectedQuest.questGiver && (
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Quest Giver</div>
            <div style={descriptionStyle}>
              {selectedQuest.questGiver}
              {selectedQuest.questGiverLocation && (
                <span style={{ color: theme.colors.text.muted }}>
                  {" "}
                  - {selectedQuest.questGiverLocation}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div style={actionsStyle}>
        {canAccept && (
          <button
            style={primaryButtonStyle}
            onClick={() => handleAcceptQuest(selectedQuest)}
          >
            Accept Quest
          </button>
        )}
        {selectedQuest.state === "active" && (
          <button
            style={secondaryButtonStyle}
            onClick={() => handleTogglePin(selectedQuest)}
          >
            {selectedQuest.pinned ? "Unpin" : "Pin"}
          </button>
        )}
        {canComplete && (
          <button
            style={primaryButtonStyle}
            onClick={() => {
              world.network?.send?.("questComplete", {
                questId: selectedQuest.id,
              });
            }}
          >
            Complete Quest
          </button>
        )}
      </div>
    </div>
  );
}

export default QuestDetailPanel;
