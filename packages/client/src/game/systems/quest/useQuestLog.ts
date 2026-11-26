/**
 * Quest Log Hook
 *
 * Hook for managing quest state including filtering, sorting,
 * and CRUD operations on quest data.
 *
 * @packageDocumentation
 */

import { useState, useCallback, useMemo, useEffect } from "react";
import { EventType } from "@hyperforge/shared";
import type { ClientWorld } from "../../../types";
import { useQuestSelectionStore } from "../../../ui/stores/questStore";
import {
  type Quest,
  type QuestState,
  type QuestCategory,
  type QuestSortOption,
  type SortDirection,
  type QuestFilterOptions,
  filterQuests,
  sortQuests,
  groupQuestsByCategory,
  calculateQuestProgress,
  canClaimQuest,
  isQuestListPayload,
} from "./questUtils";

const journalSubscriptions = new WeakMap<
  ClientWorld,
  { users: number; stop: () => void }
>();

/** Share one refresh stream across list and detached detail; no per-quest fetches. */
export function subscribeQuestSnapshots(world: ClientWorld): () => void {
  let subscription = journalSubscriptions.get(world);
  if (!subscription) {
    const network = world.network;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRequestAt = 0;
    const fetchList = () => {
      lastRequestAt = Date.now();
      network?.send?.("getQuestList", {});
    };
    const onList = (data: unknown) => {
      if (isQuestListPayload(data))
        useQuestSelectionStore.getState().applyQuestList(data);
    };
    const onProgress = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = setTimeout(
        () => {
          refreshTimer = undefined;
          fetchList();
        },
        Math.max(120, 300 - (Date.now() - lastRequestAt)),
      );
    };
    const events = [
      EventType.QUEST_STARTED,
      EventType.QUEST_PROGRESSED,
      EventType.QUEST_COMPLETED,
    ];
    network?.on("questList", onList);
    for (const event of events) world.on(event, onProgress);
    subscription = {
      users: 0,
      stop: () => {
        if (refreshTimer !== undefined) clearTimeout(refreshTimer);
        network?.off("questList", onList);
        for (const event of events) world.off(event, onProgress);
      },
    };
    journalSubscriptions.set(world, subscription);
    useQuestSelectionStore.getState().resetQuestList();
    fetchList();
  }
  const ownedSubscription = subscription;
  ownedSubscription.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--ownedSubscription.users === 0) {
      ownedSubscription.stop();
      journalSubscriptions.delete(world);
    }
  };
}

export function useServerQuestSync(world: ClientWorld): void {
  useEffect(() => subscribeQuestSnapshots(world), [world]);
}

// ============================================================================
// Types
// ============================================================================

/** Configuration for useQuestLog hook */
export interface UseQuestLogOptions {
  /** Initial quests */
  initialQuests?: Quest[];
  /** Default sort option */
  defaultSort?: QuestSortOption;
  /** Default sort direction */
  defaultSortDirection?: SortDirection;
  /** Default filter options */
  defaultFilters?: QuestFilterOptions;
  /** Callback when a quest state changes */
  onQuestStateChange?: (quest: Quest, newState: QuestState) => void;
  /** Callback when quest is pinned/unpinned */
  onQuestPinChange?: (quest: Quest, pinned: boolean) => void;
  /** Callback when objective progress changes */
  onObjectiveProgress?: (
    questId: string,
    objectiveId: string,
    current: number,
    target: number,
  ) => void;
}

/** Return value from useQuestLog hook */
export interface UseQuestLogResult {
  /** All quests (unfiltered) */
  quests: Quest[];
  /** Filtered and sorted quests */
  filteredQuests: Quest[];
  /** Quests grouped by category */
  questsByCategory: Record<QuestCategory, Quest[]>;
  /** Currently active quests count */
  activeCount: number;
  /** Total available quests count */
  availableCount: number;
  /** Completed quests count */
  completedCount: number;

  // State management
  /** Add a new quest */
  addQuest: (quest: Quest) => void;
  /** Remove a quest by ID */
  removeQuest: (questId: string) => void;
  /** Update a quest */
  updateQuest: (questId: string, updates: Partial<Quest>) => void;
  /** Set quests (replace all) */
  setQuests: (quests: Quest[]) => void;

  // Quest actions
  /** Accept/start a quest */
  acceptQuest: (questId: string) => void;
  /** Complete a quest */
  completeQuest: (questId: string) => void;
  /** Fail a quest */
  failQuest: (questId: string) => void;
  /** Toggle quest pin status */
  togglePinQuest: (questId: string) => void;
  /** Update objective progress */
  updateObjectiveProgress: (
    questId: string,
    objectiveId: string,
    current: number,
  ) => void;

  // Filtering
  /** Current filter options */
  filters: QuestFilterOptions;
  /** Set filter options */
  setFilters: (filters: QuestFilterOptions) => void;
  /** Update filter options (merge) */
  updateFilters: (filters: Partial<QuestFilterOptions>) => void;
  /** Clear all filters */
  clearFilters: () => void;
  /** Search text */
  searchText: string;
  /** Set search text */
  setSearchText: (text: string) => void;

  // Sorting
  /** Current sort option */
  sortBy: QuestSortOption;
  /** Current sort direction */
  sortDirection: SortDirection;
  /** Set sort option */
  setSortBy: (option: QuestSortOption) => void;
  /** Set sort direction */
  setSortDirection: (direction: SortDirection) => void;
  /** Toggle sort direction */
  toggleSortDirection: () => void;

  // Helpers
  /** Get a quest by ID */
  getQuest: (questId: string) => Quest | undefined;
  /** Get progress for a quest */
  getQuestProgress: (questId: string) => number;
  /** Check if quest can be completed */
  canCompleteQuest: (questId: string) => boolean;
  /** Get pinned quests */
  pinnedQuests: Quest[];
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * Quest log management hook
 *
 * Provides complete quest management with filtering, sorting,
 * and state management capabilities.
 *
 * @example
 * ```tsx
 * function QuestLogPanel() {
 *   const {
 *     filteredQuests,
 *     searchText,
 *     setSearchText,
 *     sortBy,
 *     setSortBy,
 *     acceptQuest,
 *     completeQuest,
 *   } = useQuestLog({
 *     initialQuests: myQuests,
 *     defaultSort: 'level',
 *   });
 *
 *   return (
 *     <div>
 *       <input
 *         value={searchText}
 *         onChange={(e) => setSearchText(e.target.value)}
 *         placeholder="Search quests..."
 *       />
 *       {filteredQuests.map(quest => (
 *         <QuestEntry
 *           key={quest.id}
 *           quest={quest}
 *           onAccept={() => acceptQuest(quest.id)}
 *         />
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useQuestLog(
  options: UseQuestLogOptions = {},
): UseQuestLogResult {
  const {
    initialQuests = [],
    defaultSort = "category",
    defaultSortDirection = "asc",
    defaultFilters = {},
    onQuestStateChange,
    onQuestPinChange,
    onObjectiveProgress,
  } = options;

  // Core state
  const [quests, setQuests] = useState<Quest[]>(initialQuests);
  const [filters, setFilters] = useState<QuestFilterOptions>(defaultFilters);
  const [searchText, setSearchText] = useState("");
  const [sortBy, setSortBy] = useState<QuestSortOption>(defaultSort);
  const [sortDirection, setSortDirection] =
    useState<SortDirection>(defaultSortDirection);

  // Combined filters with search
  const combinedFilters = useMemo(
    (): QuestFilterOptions => ({
      ...filters,
      searchText: searchText || undefined,
    }),
    [filters, searchText],
  );

  // Filtered and sorted quests
  const filteredQuests = useMemo(() => {
    const filtered = filterQuests(quests, combinedFilters);
    return sortQuests(filtered, sortBy, sortDirection);
  }, [quests, combinedFilters, sortBy, sortDirection]);

  // Grouped by category
  const questsByCategory = useMemo(
    () => groupQuestsByCategory(filteredQuests),
    [filteredQuests],
  );

  // Counts
  const activeCount = useMemo(
    () => quests.filter((q) => q.state === "active").length,
    [quests],
  );

  const availableCount = useMemo(
    () => quests.filter((q) => q.state === "available").length,
    [quests],
  );

  const completedCount = useMemo(
    () => quests.filter((q) => q.state === "completed").length,
    [quests],
  );

  // Pinned quests
  const pinnedQuests = useMemo(
    () =>
      quests
        .filter((q) => q.pinned && q.state === "active")
        .sort((a, b) => {
          // Pinned quests sorted by progress (most complete first)
          return calculateQuestProgress(b) - calculateQuestProgress(a);
        }),
    [quests],
  );

  // CRUD operations
  const addQuest = useCallback((quest: Quest) => {
    setQuests((prev) => [...prev, quest]);
  }, []);

  const removeQuest = useCallback((questId: string) => {
    setQuests((prev) => prev.filter((q) => q.id !== questId));
  }, []);

  const updateQuest = useCallback(
    (questId: string, updates: Partial<Quest>) => {
      setQuests((prev) =>
        prev.map((q) => (q.id === questId ? { ...q, ...updates } : q)),
      );
    },
    [],
  );

  // Quest state actions
  const updateQuestState = useCallback(
    (
      questId: string,
      newState: QuestState,
      additionalUpdates?: Partial<Quest>,
    ) => {
      setQuests((prev) =>
        prev.map((q) => {
          if (q.id !== questId) return q;

          const updatedQuest = {
            ...q,
            state: newState,
            ...additionalUpdates,
          };

          // Trigger callback
          onQuestStateChange?.(updatedQuest, newState);

          return updatedQuest;
        }),
      );
    },
    [onQuestStateChange],
  );

  const acceptQuest = useCallback(
    (questId: string) => {
      updateQuestState(questId, "active", {
        startedAt: Date.now(),
      });
    },
    [updateQuestState],
  );

  const completeQuest = useCallback(
    (questId: string) => {
      updateQuestState(questId, "completed", {
        completedAt: Date.now(),
        pinned: false,
      });
    },
    [updateQuestState],
  );

  const failQuest = useCallback(
    (questId: string) => {
      updateQuestState(questId, "failed", {
        completedAt: Date.now(),
        pinned: false,
      });
    },
    [updateQuestState],
  );

  const togglePinQuest = useCallback(
    (questId: string) => {
      setQuests((prev) =>
        prev.map((q) => {
          if (q.id !== questId) return q;

          const newPinned = !q.pinned;
          onQuestPinChange?.(q, newPinned);

          return { ...q, pinned: newPinned };
        }),
      );
    },
    [onQuestPinChange],
  );

  const updateObjectiveProgress = useCallback(
    (questId: string, objectiveId: string, current: number) => {
      setQuests((prev) =>
        prev.map((q) => {
          if (q.id !== questId) return q;

          const objectives = q.objectives.map((obj) => {
            if (obj.id !== objectiveId) return obj;

            const newCurrent = Math.min(current, obj.target);
            onObjectiveProgress?.(questId, objectiveId, newCurrent, obj.target);

            return { ...obj, current: newCurrent };
          });

          return { ...q, objectives };
        }),
      );
    },
    [onObjectiveProgress],
  );

  // Filter operations
  const updateFilters = useCallback((updates: Partial<QuestFilterOptions>) => {
    setFilters((prev) => ({ ...prev, ...updates }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({});
    setSearchText("");
  }, []);

  // Sort operations
  const toggleSortDirection = useCallback(() => {
    setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
  }, []);

  // Helpers
  const getQuest = useCallback(
    (questId: string): Quest | undefined => {
      return quests.find((q) => q.id === questId);
    },
    [quests],
  );

  const getQuestProgress = useCallback(
    (questId: string): number => {
      const quest = quests.find((q) => q.id === questId);
      return quest ? calculateQuestProgress(quest) : 0;
    },
    [quests],
  );

  const canCompleteQuest = useCallback(
    (questId: string): boolean => {
      const quest = quests.find((q) => q.id === questId);
      return quest ? canClaimQuest(quest) : false;
    },
    [quests],
  );

  return {
    // Data
    quests,
    filteredQuests,
    questsByCategory,
    activeCount,
    availableCount,
    completedCount,
    pinnedQuests,

    // CRUD
    addQuest,
    removeQuest,
    updateQuest,
    setQuests,

    // Quest actions
    acceptQuest,
    completeQuest,
    failQuest,
    togglePinQuest,
    updateObjectiveProgress,

    // Filtering
    filters,
    setFilters,
    updateFilters,
    clearFilters,
    searchText,
    setSearchText,

    // Sorting
    sortBy,
    sortDirection,
    setSortBy,
    setSortDirection,
    toggleSortDirection,

    // Helpers
    getQuest,
    getQuestProgress,
    canCompleteQuest,
  };
}
