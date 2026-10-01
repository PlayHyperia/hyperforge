import { useEffect, type MutableRefObject } from "react";
import type { ClientWorld } from "../../types";
import { useQuestSelectionStore } from "../../ui/stores/questStore";
import { useServerQuestSync } from "../systems/quest/useQuestLog";
import type { QuestState } from "../systems/quest/questUtils";

interface UseQuestStatusSyncOptions {
  world: ClientWorld;
  questStatusesRef: MutableRefObject<Map<string, string>>;
  setQuestStatuses: (quests: Array<{ id: string; state: QuestState }>) => void;
}

/** Minimap and journal share one bounded refresh owner and authoritative list. */
export function useQuestStatusSync({
  world,
  questStatusesRef,
  setQuestStatuses,
}: UseQuestStatusSyncOptions): void {
  useServerQuestSync(world);
  const quests = useQuestSelectionStore((state) => state.quests);
  useEffect(() => {
    questStatusesRef.current = new Map(
      quests.map((quest) => [quest.id, quest.state]),
    );
    setQuestStatuses(
      quests.map((quest) => ({ id: quest.id, state: quest.state })),
    );
  }, [quests, questStatusesRef, setQuestStatuses]);
}
