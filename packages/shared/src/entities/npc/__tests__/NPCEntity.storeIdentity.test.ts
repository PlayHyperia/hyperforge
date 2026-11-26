import { describe, expect, it } from "vitest";
import { EntityType, InteractionType, NPCType } from "../../../types/entities";
import { NPCEntity } from "../NPCEntity";

describe("NPCEntity store identity", () => {
  it("retains the exact manifest store ID in authoritative and network data", () => {
    const npc = new NPCEntity(
      {
        isServer: true,
        isClient: false,
        stage: { scene: { add() {} } },
        emit() {},
      } as never,
      {
        id: "npc-torvin-1",
        name: "Torvin",
        type: EntityType.NPC,
        position: { x: -28, y: 0, z: 24 },
        visible: true,
        interactable: true,
        interactionType: InteractionType.TALK,
        interactionDistance: 2,
        description: "Sword supplier",
        model: null,
        npcType: NPCType.QUEST_GIVER,
        npcId: "torvin",
        storeId: "sword_store",
        dialogueLines: [],
        services: [],
        inventory: [],
        skillsOffered: [],
        questsAvailable: [],
        properties: {} as never,
      },
    );

    expect(npc.data.storeId).toBe("sword_store");
    expect(npc.getNetworkData()).toMatchObject({
      npcId: "torvin",
      storeId: "sword_store",
    });
    expect(npc.serialize()).toMatchObject({
      npcId: "torvin",
      storeId: "sword_store",
    });
  });
});
