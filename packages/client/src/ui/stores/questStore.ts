/**
 * Quest Selection Store
 *
 * Manages the currently selected quest for the quest detail panel.
 * Used to communicate between QuestsPanel (list) and QuestDetailPanel (detail view).
 *
 * Also tracks quest statuses for minimap quest icons (available/active/completed).
 */

import { create } from "zustand";
import type { QuestListPayload } from "@hyperforge/shared";
import {
  questFromSnapshot,
  type Quest,
  type QuestState,
} from "../../game/systems/quest/questUtils";

/** Quest selection store state and actions */
export interface QuestSelectionState {
  /** Latest authoritative journal, independent of which windows are open. */
  quests: Quest[];
  questsLoaded: boolean;
  applyQuestList: (payload: QuestListPayload) => void;
  resetQuestList: () => void;
  /** The currently selected quest (null if none) */
  selectedQuest: Quest | null;
  /** Set the selected quest */
  setSelectedQuest: (quest: Quest | null) => void;
  /** Clear the selected quest */
  clearSelectedQuest: () => void;
  /** Quest status map: questId → QuestState ("available" | "active" | "completed") */
  questStatuses: Map<string, QuestState>;
  /** Update quest statuses from server quest list */
  setQuestStatuses: (quests: Array<{ id: string; state: QuestState }>) => void;
}

/**
 * Zustand store for quest selection state
 *
 * This store is used to share the selected quest between the quest list
 * and the quest detail panel, which may be in separate windows.
 */
export const useQuestSelectionStore = create<QuestSelectionState>((set) => ({
  quests: [],
  questsLoaded: false,
  applyQuestList: (payload) =>
    set((state) => {
      const quests = payload.quests.map(questFromSnapshot);
      const selected = quests.find(
        (quest) => quest.id === state.selectedQuest?.id,
      );
      return {
        quests,
        questsLoaded: true,
        selectedQuest: selected
          ? { ...selected, pinned: state.selectedQuest?.pinned ?? false }
          : null,
        questStatuses: new Map(quests.map((quest) => [quest.id, quest.state])),
      };
    }),
  resetQuestList: () =>
    set({
      quests: [],
      questsLoaded: false,
      selectedQuest: null,
      questStatuses: new Map(),
    }),
  selectedQuest: null,
  setSelectedQuest: (quest) =>
    set((state) => ({
      selectedQuest: quest
        ? {
            ...(state.quests.find((entry) => entry.id === quest.id) ?? quest),
            pinned: quest.pinned,
          }
        : null,
    })),
  clearSelectedQuest: () => set({ selectedQuest: null }),
  questStatuses: new Map(),
  setQuestStatuses: (quests) => {
    const map = new Map<string, QuestState>();
    for (const q of quests) {
      map.set(q.id, q.state);
    }
    set({ questStatuses: map });
  },
}));
