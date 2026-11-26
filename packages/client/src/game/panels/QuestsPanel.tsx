/**
 * QuestsPanel - Quest Log panel for the game interface
 *
 * Connects the QuestLog component to the server's quest system via network.
 * Displays available, active, and completed quests with filtering and sorting.
 * Uses theme utilities for consistent styling with other panels.
 *
 * Desktop: When a quest is clicked, it opens the QuestDetailPanel in a separate window.
 * Mobile: Quest details are shown inline with a back button to return to the list.
 * State is persisted so reopening the panel shows the last viewed quest.
 */

import React, { useState, useCallback, useMemo, useEffect } from "react";
import { useServerQuestSync } from "../systems/quest/useQuestLog";
import { canClaimQuest } from "../systems/quest/questUtils";
import {
  useWindowStore,
  useQuestSelectionStore,
  useMobileLayout,
  useTheme,
} from "@/ui";
import { getPanelSurfaceStyle, getPanelInsetStyle } from "@/ui/theme/themes";
import {
  PANEL_MOBILE_PADDING,
  PANEL_SLOT_RADIUS,
} from "../../constants/panelLayout";
import { QuestLog } from "@/game/components/quest";
import {
  type Quest,
  type QuestState,
  type QuestCategory,
  type QuestSortOption,
  type SortDirection,
  sortQuests,
  filterQuests,
  calculateQuestProgress,
  CATEGORY_CONFIG,
  STATE_CONFIG,
} from "@/game/systems";
import { parseJSONWithDefault } from "../../utils/validation";
import type { ClientWorld } from "../../types";

/** Type guard for string array */
function isStringArray(data: unknown): data is string[] {
  return Array.isArray(data) && data.every((item) => typeof item === "string");
}

interface QuestsPanelProps {
  world: ClientWorld;
}

/** LocalStorage key for pinned quests */
const PINNED_QUESTS_KEY = "hyperia_pinned_quests";

/** LocalStorage key for last viewed quest (mobile state persistence) */
const LAST_VIEWED_QUEST_KEY = "hyperia_last_viewed_quest";

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

/** Load last viewed quest ID from localStorage */
function loadLastViewedQuest(): string | null {
  try {
    return localStorage.getItem(LAST_VIEWED_QUEST_KEY);
  } catch {
    return null;
  }
}

/** Save last viewed quest ID to localStorage */
function saveLastViewedQuest(questId: string | null): void {
  try {
    if (questId) {
      localStorage.setItem(LAST_VIEWED_QUEST_KEY, questId);
    } else {
      localStorage.removeItem(LAST_VIEWED_QUEST_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

function getStateColor(state: QuestState): string {
  return STATE_CONFIG[state].color;
}

const CATEGORY_ICONS: Record<string, string> = {
  crown: "\u{1F451}",
  scroll: "\u{1F4DC}",
  sun: "\u2600\uFE0F",
  calendar: "\u{1F4C5}",
  star: "\u2B50",
};

/** Props for MobileQuestDetail component */
interface MobileQuestDetailProps {
  quest: Quest;
  onBack: () => void;
  onTogglePin: (quest: Quest) => void;
  onAcceptQuest: (quest: Quest) => void;
  world: ClientWorld;
  theme: ReturnType<typeof useTheme>;
}

/**
 * MobileQuestDetail - Inline quest detail view for mobile
 *
 * Displays quest details within the same panel with a back button
 * to return to the quest list.
 */
function MobileQuestDetail({
  quest,
  onBack,
  onTogglePin,
  onAcceptQuest,
  world,
  theme,
}: MobileQuestDetailProps) {
  const progress = calculateQuestProgress(quest);
  const categoryConfig = CATEGORY_CONFIG[quest.category];
  const categoryIcon =
    CATEGORY_ICONS[categoryConfig.icon] || categoryConfig.icon;
  const canAccept = quest.state === "available";
  const canComplete = canClaimQuest(quest);

  const containerStyle: React.CSSProperties = {
    ...getPanelSurfaceStyle(theme),
    height: "100%",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  };

  const headerStyle: React.CSSProperties = {
    ...getPanelInsetStyle(theme, { radius: 0 }),
    display: "flex",
    alignItems: "center",
    gap: theme.spacing.sm,
    padding: `${PANEL_MOBILE_PADDING * 2 + 2}px`,
    borderBottom: `1px solid ${theme.colors.border.default}`,
    minHeight: "48px",
  };

  const backButtonStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "36px",
    height: "36px",
    background: "transparent",
    border: "none",
    color: theme.colors.text.secondary,
    cursor: "pointer",
    padding: 0,
    borderRadius: `${PANEL_SLOT_RADIUS}px`,
  };

  const titleStyle: React.CSSProperties = {
    flex: 1,
    color: getStateColor(quest.state),
    fontSize: theme.typography.fontSize.lg,
    fontWeight: theme.typography.fontWeight.semibold,
    margin: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    overflowY: "auto",
    padding: `${PANEL_MOBILE_PADDING * 2 + 2}px`,
    WebkitOverflowScrolling: "touch",
  };

  const sectionStyle: React.CSSProperties = {
    marginBottom: theme.spacing.sm,
  };

  const sectionTitleStyle: React.CSSProperties = {
    color: theme.colors.accent.primary,
    fontSize: theme.typography.fontSize.sm,
    fontWeight: theme.typography.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    marginBottom: theme.spacing.xs,
  };

  const descriptionStyle: React.CSSProperties = {
    color: theme.colors.text.secondary,
    fontSize: theme.typography.fontSize.base,
    lineHeight: theme.typography.lineHeight.normal,
    margin: 0,
  };

  const metaRowStyle: React.CSSProperties = {
    ...getPanelInsetStyle(theme, { radius: PANEL_SLOT_RADIUS }),
    display: "flex",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.sm,
    fontSize: theme.typography.fontSize.base,
  };

  const metaItemStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: "calc(50% - 8px)",
  };

  const metaLabelStyle: React.CSSProperties = {
    color: theme.colors.text.muted,
    fontSize: theme.typography.fontSize.sm,
    textTransform: "uppercase",
  };

  const metaValueStyle: React.CSSProperties = {
    color: theme.colors.text.primary,
    fontWeight: theme.typography.fontWeight.medium,
  };

  const progressBarContainerStyle: React.CSSProperties = {
    height: "6px",
    backgroundColor: theme.colors.background.tertiary,
    borderRadius: `${PANEL_SLOT_RADIUS}px`,
    overflow: "hidden",
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.sm,
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
    gap: theme.spacing.xs,
    padding: `${theme.spacing.xs}px 0`,
    color: completed ? theme.colors.state.success : theme.colors.text.secondary,
    fontSize: theme.typography.fontSize.base,
    textDecoration: completed ? "line-through" : "none",
    opacity: completed ? 0.7 : 1,
  });

  const actionsStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: theme.spacing.sm,
    padding: `${PANEL_MOBILE_PADDING * 2 + 2}px`,
    borderTop: `1px solid ${theme.colors.border.default}`,
    background: theme.colors.background.secondary,
  };

  const buttonBaseStyle: React.CSSProperties = {
    padding: `${theme.spacing.md}px`,
    border: "none",
    borderRadius: `${PANEL_SLOT_RADIUS}px`,
    fontSize: theme.typography.fontSize.base,
    fontWeight: theme.typography.fontWeight.medium,
    cursor: "pointer",
    transition: theme.transitions.fast,
    minHeight: "44px",
  };

  const primaryButtonStyle: React.CSSProperties = {
    ...buttonBaseStyle,
    background: theme.colors.accent.primary,
    color: theme.colors.background.primary,
  };

  const secondaryButtonStyle: React.CSSProperties = {
    ...buttonBaseStyle,
    background: theme.colors.background.tertiary,
    color: theme.colors.text.primary,
    border: `1px solid ${theme.colors.border.default}`,
  };

  return (
    <div style={containerStyle}>
      {/* Header with back button */}
      <div style={headerStyle}>
        <button
          style={backButtonStyle}
          onClick={onBack}
          title="Back to quest list"
        >
          <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
            <path
              d="M11 2L5 8l6 6"
              stroke="currentColor"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <h3 style={titleStyle}>
          {quest.pinned && (
            <span
              style={{ color: theme.colors.accent.gold, marginRight: "6px" }}
              title="Pinned"
            >
              ★
            </span>
          )}
          {quest.title}
        </h3>
      </div>

      {/* Content */}
      <div style={contentStyle} className="scrollbar-thin">
        {/* Meta info */}
        <div style={metaRowStyle}>
          <div style={metaItemStyle}>
            <span style={metaLabelStyle}>Category</span>
            <span style={{ ...metaValueStyle, color: categoryConfig.color }}>
              {categoryIcon} {categoryConfig.label}
            </span>
          </div>
          <div style={metaItemStyle}>
            <span style={metaLabelStyle}>Level</span>
            <span style={metaValueStyle}>{quest.level || 1}</span>
          </div>
          <div style={metaItemStyle}>
            <span style={metaLabelStyle}>Status</span>
            <span
              style={{
                ...metaValueStyle,
                color: getStateColor(quest.state),
              }}
            >
              {quest.state.charAt(0).toUpperCase() + quest.state.slice(1)}
            </span>
          </div>
          {quest.state === "active" && (
            <div style={metaItemStyle}>
              <span style={metaLabelStyle}>Progress</span>
              <span style={metaValueStyle}>{progress}%</span>
            </div>
          )}
        </div>

        {/* Progress bar for active quests */}
        {quest.state === "active" && (
          <div style={progressBarContainerStyle}>
            <div style={progressBarFillStyle} />
          </div>
        )}

        {/* Description */}
        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>Description</div>
          <p style={descriptionStyle}>{quest.description}</p>
        </div>

        {/* Objectives */}
        {quest.objectives && quest.objectives.length > 0 && (
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Objectives</div>
            {quest.objectives.map((obj) => {
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
        {quest.rewards && quest.rewards.length > 0 && (
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Rewards</div>
            {quest.rewards.map((reward, idx) => (
              <div
                key={idx}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: theme.spacing.xs,
                  padding: `${theme.spacing.xs}px 0`,
                  color: theme.colors.text.secondary,
                  fontSize: theme.typography.fontSize.base,
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
        {quest.questGiver && (
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Quest Giver</div>
            <div style={descriptionStyle}>
              {quest.questGiver}
              {quest.questGiverLocation && (
                <span style={{ color: theme.colors.text.muted }}>
                  {" "}
                  - {quest.questGiverLocation}
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
            onClick={() => onAcceptQuest(quest)}
          >
            Accept Quest
          </button>
        )}
        {quest.state === "active" && (
          <button
            style={secondaryButtonStyle}
            onClick={() => onTogglePin(quest)}
          >
            {quest.pinned ? "Unpin" : "Pin"}
          </button>
        )}
        {canComplete && (
          <button
            style={primaryButtonStyle}
            onClick={() => {
              world.network?.send?.("questComplete", {
                questId: quest.id,
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

/**
 * QuestsPanel Component
 *
 * Displays the quest log with filtering, sorting, and quest management.
 * Connects to the game world for quest data and actions via network.
 *
 * Desktop: Opens quest details in a separate window.
 * Mobile: Shows quest details inline with a back button.
 */
export function QuestsPanel({ world }: QuestsPanelProps) {
  useServerQuestSync(world);
  // Theme and mobile detection
  const theme = useTheme();
  const { shouldUseMobileUI } = useMobileLayout();

  // Filter state
  const [searchText, setSearchText] = useState("");
  const [stateFilter, setStateFilter] = useState<QuestState[]>([
    "available",
    "active",
  ]);
  const [categoryFilter, setCategoryFilter] = useState<QuestCategory[]>([]);
  const [sortBy, setSortBy] = useState<QuestSortOption>("category");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  // Quest data from server
  const allQuests = useQuestSelectionStore((state) => state.quests);
  const loading = useQuestSelectionStore((state) => !state.questsLoaded);

  // Mobile inline quest viewing state
  // When viewing a quest on mobile, this holds the quest ID
  const [mobileViewingQuestId, setMobileViewingQuestId] = useState<
    string | null
  >(() => {
    // Restore last viewed quest on mount (only if mobile)
    if (typeof window !== "undefined") {
      return loadLastViewedQuest();
    }
    return null;
  });

  // Pinned quests (client-side only, persisted to localStorage)
  const [pinnedQuestIds, setPinnedQuestIds] =
    useState<Set<string>>(loadPinnedQuests);

  // Listen for pin changes from other components (e.g., QuestDetailPanel)
  useEffect(() => {
    const handlePinChange = (event: Event) => {
      const customEvent = event as CustomEvent<{
        questId: string;
        pinned: boolean;
      }>;
      const { questId, pinned } = customEvent.detail;
      setPinnedQuestIds((prev) => {
        const newSet = new Set(prev);
        if (pinned) {
          newSet.add(questId);
        } else {
          newSet.delete(questId);
        }
        return newSet;
      });
    };

    window.addEventListener("questPinChanged", handlePinChange);
    return () => window.removeEventListener("questPinChanged", handlePinChange);
  }, []);

  // Pinning is local; all progress comes from the latest shared snapshot.
  const mergedQuests = useMemo(
    () =>
      allQuests.map((quest) => ({
        ...quest,
        pinned: pinnedQuestIds.has(quest.id),
      })),
    [allQuests, pinnedQuestIds],
  );

  // Filter and sort quests
  const filteredQuests = useMemo(() => {
    let quests = [...mergedQuests];

    // Apply filters
    quests = filterQuests(quests, {
      searchText: searchText,
      states: stateFilter.length > 0 ? stateFilter : undefined,
      categories: categoryFilter.length > 0 ? categoryFilter : undefined,
    });

    // Apply sorting
    quests = sortQuests(quests, sortBy, sortDirection);

    return quests;
  }, [
    mergedQuests,
    searchText,
    stateFilter,
    categoryFilter,
    sortBy,
    sortDirection,
  ]);

  // Quest counts
  const questCounts = useMemo(
    () => ({
      active: mergedQuests.filter((q) => q.state === "active").length,
      available: mergedQuests.filter((q) => q.state === "available").length,
      completed: mergedQuests.filter((q) => q.state === "completed").length,
    }),
    [mergedQuests],
  );

  // Quest actions
  const handleAcceptQuest = useCallback(
    (quest: Quest) => {
      // Send accept quest request to server
      world.network?.send?.("questAccept", { questId: quest.id });
    },
    [world],
  );

  const handleTogglePin = useCallback(
    (quest: Quest) => {
      // Toggle pinned state - client-side only, persisted to localStorage
      const newPinned = !pinnedQuestIds.has(quest.id);
      setPinnedQuestIds((prev) => {
        const newSet = new Set(prev);
        if (newSet.has(quest.id)) {
          newSet.delete(quest.id);
        } else {
          newSet.add(quest.id);
        }
        savePinnedQuests(newSet);
        return newSet;
      });

      // Dispatch event to sync other components (e.g., QuestDetailPanel, QuestLog popup)
      window.dispatchEvent(
        new CustomEvent("questPinChanged", {
          detail: { questId: quest.id, pinned: newPinned },
        }),
      );
    },
    [pinnedQuestIds],
  );

  const handleTrackQuest = useCallback(
    (quest: Quest) => {
      // Track quest on screen
      world.network?.send?.("questTrack", { questId: quest.id });
    },
    [world],
  );

  // Get quest selection store and window store for opening quest detail
  const selectedQuest = useQuestSelectionStore((s) => s.selectedQuest);
  const setSelectedQuest = useQuestSelectionStore((s) => s.setSelectedQuest);
  const createWindow = useWindowStore((s) => s.createWindow);

  // The list snapshot already includes details and objective denominators.
  const handleQuestClick = useCallback(
    (quest: Quest) => {
      setSelectedQuest(quest);

      // Mobile: Show quest inline within this panel
      if (shouldUseMobileUI) {
        setMobileViewingQuestId(quest.id);
        saveLastViewedQuest(quest.id);
        return;
      }

      // Desktop: Open quest detail in separate window
      // Check if quest-detail window already exists
      const windows = useWindowStore.getState().windows;
      const existingWindow = windows.get("quest-detail-window");

      if (existingWindow) {
        // If window exists, just make it visible and bring to front
        useWindowStore.getState().updateWindow("quest-detail-window", {
          visible: true,
        });
        useWindowStore.getState().bringToFront("quest-detail-window");
      } else {
        // Create new quest detail window
        const viewport = {
          width: typeof window !== "undefined" ? window.innerWidth : 1920,
          height: typeof window !== "undefined" ? window.innerHeight : 1080,
        };

        createWindow({
          id: "quest-detail-window",
          position: {
            x: Math.floor(viewport.width / 2 - 200),
            y: Math.floor(viewport.height / 2 - 250),
          },
          size: { width: 400, height: 500 },
          minSize: { width: 320, height: 400 },
          maxSize: { width: 500, height: 700 },
          tabs: [
            { id: "quest-detail", label: "Quest", content: "quest-detail" },
          ],
          transparency: 0,
        });
      }
    },
    [setSelectedQuest, createWindow, shouldUseMobileUI],
  );

  // Handle back button on mobile - return to quest list
  const handleMobileBack = useCallback(() => {
    setMobileViewingQuestId(null);
    // Don't clear localStorage - we want to remember the quest for next open
    // User can navigate back to the quest from the list
  }, []);

  // Container style using theme colors for consistency
  const containerStyle: React.CSSProperties = {
    height: "100%",
    ...getPanelSurfaceStyle(theme, { emphasis: "normal" }),
    display: "flex",
    flexDirection: "column",
  };

  // Show loading state
  if (loading) {
    return (
      <div style={containerStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "#888",
          }}
        >
          Loading quests...
        </div>
      </div>
    );
  }

  // Get the quest being viewed on mobile (from merged quests which have details)
  const mobileViewingQuest = mobileViewingQuestId
    ? mergedQuests.find((q) => q.id === mobileViewingQuestId)
    : null;

  // Mobile: Show quest detail inline if viewing a quest
  if (shouldUseMobileUI && mobileViewingQuest) {
    return (
      <div style={containerStyle}>
        <MobileQuestDetail
          quest={mobileViewingQuest}
          onBack={handleMobileBack}
          onTogglePin={handleTogglePin}
          onAcceptQuest={handleAcceptQuest}
          world={world}
          theme={theme}
        />
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <QuestLog
        quests={filteredQuests}
        questCounts={questCounts}
        searchText={searchText}
        onSearchChange={setSearchText}
        sortBy={sortBy}
        onSortChange={setSortBy}
        sortDirection={sortDirection}
        onSortDirectionChange={setSortDirection}
        stateFilter={stateFilter}
        onStateFilterChange={setStateFilter}
        categoryFilter={categoryFilter}
        onCategoryFilterChange={setCategoryFilter}
        selectedQuestId={selectedQuest?.id ?? null}
        onTogglePin={handleTogglePin}
        onAcceptQuest={handleAcceptQuest}
        onTrackQuest={handleTrackQuest}
        groupByCategory
        showSearch
        showFilters
        showSort
        showHeader
        title="Quest Log"
        emptyMessage="No quests available. Talk to NPCs to discover new quests!"
        useExternalPopup
        onQuestClick={handleQuestClick}
        style={{
          height: "100%",
          border: "none",
          background: "transparent",
        }}
      />
    </div>
  );
}

export default QuestsPanel;
