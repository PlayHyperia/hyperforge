import { describe, expect, it } from "vitest";
import { World } from "../../../core/World";
import { EventType } from "../../../types/events";
import {
  EntityType,
  InteractionType,
  type BankEntityConfig,
  type EntityInteractionData,
} from "../../../types/entities";
import { BankEntity } from "../BankEntity";

describe("BankEntity interaction identity", () => {
  it("opens a physical bank with its runtime entity ID, not its manifest alias", async () => {
    const world = new World();
    const runtimeEntityId = "station_bank_outlier_west";
    const manifestBankAlias = "shared_player_bank";
    const playerId = "player-bank-identity-proof";
    const config: BankEntityConfig = {
      id: runtimeEntityId,
      name: "West Bank Chest",
      type: EntityType.BANK,
      position: { x: 24, y: 0, z: 32 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      visible: true,
      interactable: true,
      interactionType: InteractionType.BANK,
      interactionDistance: 3,
      description: "A secure place to store items.",
      model: null,
      properties: {
        movementComponent: null,
        combatComponent: null,
        healthComponent: null,
        visualComponent: null,
        health: { current: 1, max: 1 },
        level: 1,
        bankId: manifestBankAlias,
      },
    };
    const bank = new BankEntity(world, config);
    const opened: unknown[] = [];
    world.on(EventType.BANK_OPEN, (payload) => opened.push(payload));

    const interaction: EntityInteractionData = {
      playerId,
      entityId: runtimeEntityId,
      interactionType: InteractionType.BANK,
      position: { x: 24, y: 0, z: 32 },
      playerPosition: { x: 23, y: 0, z: 32 },
    };

    try {
      await bank.handleInteraction(interaction);

      expect(opened).toEqual([{ playerId, bankId: runtimeEntityId }]);
      expect(opened).not.toContainEqual({
        playerId,
        bankId: manifestBankAlias,
      });
    } finally {
      bank.destroy();
      world.destroy();
    }
  });
});
