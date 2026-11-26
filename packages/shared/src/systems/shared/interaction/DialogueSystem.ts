/**
 * DialogueSystem - Handles NPC dialogue trees
 *
 * Features:
 * - Processes dialogue trees from npcs.json
 * - Manages dialogue state per player
 * - Executes effects (openBank, startQuest, etc.)
 * - Sends dialogue packets to clients
 */

import type { World } from "../../../core/World";
import { EventType } from "../../../types/events";
import { SystemBase } from "../infrastructure/SystemBase";
import { getNPCById } from "../../../data/npcs";
import type {
  NPCDialogueTree,
  NPCDialogueNode,
} from "../../../types/entities/npc-mob-types";
import { isValidQuestId } from "../../../types/game/quest-types";

interface DialogueState {
  npcId: string;
  npcName: string;
  dialogueTree: NPCDialogueTree;
  currentNodeId: string;
  npcEntityId?: string;
  pendingEffect?: string; // Effect to execute when player continues from terminal node
  isTerminal?: boolean; // Whether current node is terminal (no responses)
}

/**
 * DialogueSystem
 * Manages NPC dialogue interactions using dialogue trees from npcs.json
 */
export class DialogueSystem extends SystemBase {
  // Active dialogues per player
  private activeDialogues = new Map<string, DialogueState>();

  private isImmediateHandoffEffect(effect?: string): boolean {
    if (!effect) {
      return false;
    }

    const [effectName] = effect.split(":");
    return (
      effectName === "openBank" ||
      effectName === "openShop" ||
      effectName === "openStore" ||
      effectName === "openTanner"
    );
  }

  constructor(world: World) {
    super(world, {
      name: "dialogue",
      dependencies: {
        required: [],
        optional: ["npc", "banking", "store"],
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    // Subscribe to NPC interaction events
    this.subscribe(
      EventType.NPC_INTERACTION,
      (data: {
        playerId: string;
        npcId: string;
        npc: { id: string; name: string; type: string };
        npcEntityId?: string;
      }) => {
        this.handleNPCInteraction(data);
      },
    );

    // Subscribe to dialogue response events (from client)
    this.subscribe(
      EventType.DIALOGUE_RESPONSE,
      (data: {
        playerId: string;
        npcId: string;
        responseIndex: number;
        nextNodeId: string;
        effect?: string;
      }) => {
        this.handleDialogueResponse(data);
      },
    );

    // Subscribe to dialogue continue events (from client on terminal nodes)
    this.subscribe(
      EventType.DIALOGUE_CONTINUE,
      (data: { playerId: string; npcId: string }) => {
        this.handleDialogueContinue(data);
      },
    );

    // Subscribe to dialogue end events (from dialogueClose handler when player clicks X)
    // This cleans up state WITHOUT executing pending effects
    this.subscribe(
      EventType.DIALOGUE_END,
      (data: { playerId: string; npcId: string }) => {
        // Only clean up if this came from external source (dialogueClose handler)
        // Our own endDialogue also emits this, but after we've already cleaned up
        const state = this.activeDialogues.get(data.playerId);
        if (state && state.npcId === data.npcId) {
          // Don't execute pending effect - player explicitly closed dialogue
          this.activeDialogues.delete(data.playerId);
        }
      },
    );
  }

  /**
   * Handle NPC interaction - start dialogue if NPC has dialogue tree
   */
  private handleNPCInteraction(data: {
    playerId: string;
    npcId: string;
    npc: { id: string; name: string; type: string };
    npcEntityId?: string;
  }): void {
    const { playerId, npc, npcEntityId } = data;

    // Look up NPC data from manifest
    const npcData = getNPCById(npc.id);

    if (!npcData || !npcData.dialogue) {
      // No dialogue tree - fall back to legacy NPC handling
      // The NPCSystem will handle this via its own subscription
      return;
    }

    // Start dialogue (pass npcEntityId for distance checking on client)
    this.startDialogue(
      playerId,
      npc.id,
      npc.name,
      npcData.dialogue,
      npcEntityId,
    );
  }

  /**
   * Start a dialogue with an NPC
   */
  private startDialogue(
    playerId: string,
    npcId: string,
    npcName: string,
    dialogueTree: NPCDialogueTree,
    npcEntityId?: string,
  ): void {
    // Determine entry node ID, considering quest overrides
    let entryNodeId = dialogueTree.entryNodeId;

    // Check for quest-based entry node overrides
    if (dialogueTree.questOverrides) {
      const questSystem = this.world.getSystem("quest") as {
        getQuestStatus?: (
          playerId: string,
          questId: string,
        ) => "not_started" | "in_progress" | "ready_to_complete" | "completed";
      };

      if (questSystem?.getQuestStatus) {
        // Check each quest's status and use override if available
        for (const [questId, overrides] of Object.entries(
          dialogueTree.questOverrides,
        )) {
          const status = questSystem.getQuestStatus(playerId, questId);

          // Priority: ready_to_complete > in_progress > completed > default
          if (status === "ready_to_complete" && overrides.ready_to_complete) {
            entryNodeId = overrides.ready_to_complete;
            break; // Use first matching quest override
          } else if (status === "in_progress" && overrides.in_progress) {
            entryNodeId = overrides.in_progress;
            break;
          } else if (status === "completed" && overrides.completed) {
            entryNodeId = overrides.completed;
            break;
          }
        }
      }
    }

    // Find entry node
    const entryNode = dialogueTree.nodes.find(
      (node) => node.id === entryNodeId,
    );
    if (!entryNode) {
      this.logger.error(
        `Dialogue tree for ${npcId} has invalid entryNodeId: ${entryNodeId}`,
      );
      return;
    }

    // Store dialogue state (include npcEntityId for distance checking)
    this.activeDialogues.set(playerId, {
      npcId,
      npcName,
      dialogueTree,
      currentNodeId: entryNode.id,
      npcEntityId,
    });

    // Send dialogue start to client (include npcEntityId)
    this.sendDialogueNode(
      playerId,
      npcId,
      npcName,
      entryNode,
      true,
      npcEntityId,
    );

    // Check if entry node is terminal (no responses)
    if (!entryNode.responses || entryNode.responses.length === 0) {
      // Store pending effect for terminal node - will execute when player clicks continue
      const state = this.activeDialogues.get(playerId);
      if (state && entryNode.effect) {
        state.pendingEffect = entryNode.effect;
        state.isTerminal = true;
        this.logger.info(
          `[DialogueSystem] Terminal entry node ${entryNode.id} has pending effect: ${entryNode.effect}`,
        );
      } else if (state) {
        state.isTerminal = true;
      }
      // Don't end dialogue yet - wait for player to click continue
    }
  }

  /**
   * Handle player selecting a dialogue response
   *
   * SECURITY: Server determines nextNodeId and effect from its own dialogue state.
   * The client only sends responseIndex - we NEVER trust client-provided
   * nextNodeId or effect values to prevent dialogue skipping exploits.
   */
  private handleDialogueResponse(data: {
    playerId: string;
    npcId: string;
    responseIndex: number;
    // NOTE: nextNodeId and effect are intentionally NOT accepted from client
    // Server computes these from dialogue state based on responseIndex
  }): void {
    const { playerId, npcId, responseIndex } = data;

    const state = this.activeDialogues.get(playerId);
    if (!state || state.npcId !== npcId) {
      this.logger.warn(
        `No active dialogue for player ${playerId} with NPC ${npcId}`,
      );
      return;
    }

    // Get current node from SERVER state
    const currentNode = state.dialogueTree.nodes.find(
      (node) => node.id === state.currentNodeId,
    );
    if (
      !currentNode ||
      !currentNode.responses ||
      currentNode.responses.length === 0
    ) {
      this.logger.warn(`Current node ${state.currentNodeId} has no responses`);
      this.endDialogue(playerId, npcId);
      return;
    }

    // Validate responseIndex is in bounds (SECURITY: prevent array out-of-bounds)
    if (responseIndex < 0 || responseIndex >= currentNode.responses.length) {
      this.logger.warn(
        `Invalid responseIndex ${responseIndex} for node with ${currentNode.responses.length} responses`,
      );
      return;
    }

    // SERVER determines nextNodeId and effect from the selected response
    const selectedResponse = currentNode.responses[responseIndex];
    const nextNodeId = selectedResponse.nextNodeId;
    const effect = selectedResponse.effect;

    // Service panel handoff responses should end the dialogue immediately.
    // These are not real conversational branches; the next UI owns the flow.
    if (effect && this.isImmediateHandoffEffect(effect)) {
      this.executeEffect(playerId, npcId, effect, state.npcEntityId);
      this.endDialogue(playerId, npcId);
      return;
    }

    // Execute effect if present (now from SERVER data, not client)
    if (effect) {
      this.executeEffect(playerId, npcId, effect, state.npcEntityId);
    }

    // Find next node (using SERVER-determined nextNodeId)
    const nextNode = state.dialogueTree.nodes.find(
      (node) => node.id === nextNodeId,
    );
    if (!nextNode) {
      // End dialogue if no next node
      this.endDialogue(playerId, npcId);
      return;
    }

    const nextNodeIsTerminal =
      !nextNode.responses || nextNode.responses.length === 0;

    // Update state
    state.currentNodeId = nextNodeId;

    // Check if this node has responses
    if (nextNodeIsTerminal) {
      // Terminal node - store pending effect instead of executing immediately
      // Effect will execute when player clicks continue
      if (nextNode.effect) {
        state.pendingEffect = nextNode.effect;
        this.logger.info(
          `[DialogueSystem] Terminal node ${nextNode.id} has pending effect: ${nextNode.effect}`,
        );
      } else {
        this.logger.info(
          `[DialogueSystem] Terminal node ${nextNode.id} has no effect`,
        );
      }
      state.isTerminal = true;
      // Send final node text - don't end dialogue yet, wait for player continue
      this.sendDialogueNode(playerId, npcId, state.npcName, nextNode, false);
    } else {
      // Continue dialogue
      this.sendDialogueNode(playerId, npcId, state.npcName, nextNode, false);
    }
  }

  /**
   * Handle player clicking "continue" on a terminal dialogue node
   * This executes any pending effects and ends the dialogue
   */
  private handleDialogueContinue(data: {
    playerId: string;
    npcId: string;
  }): void {
    const { playerId, npcId } = data;

    const state = this.activeDialogues.get(playerId);
    if (!state || state.npcId !== npcId) {
      // No active dialogue or wrong NPC - just ignore
      return;
    }

    // Execute pending effect if present
    if (state.pendingEffect) {
      this.logger.info(
        `[DialogueSystem] Executing pending effect on continue: ${state.pendingEffect}`,
      );
      this.executeEffect(
        playerId,
        npcId,
        state.pendingEffect,
        state.npcEntityId,
      );
    }

    // End the dialogue
    this.endDialogue(playerId, npcId);
  }

  /**
   * Send dialogue node to client
   * Emits events that EventBridge forwards to the client via network packets
   */
  private sendDialogueNode(
    playerId: string,
    npcId: string,
    npcName: string,
    node: NPCDialogueNode,
    isStart: boolean,
    npcEntityId?: string,
  ): void {
    const responses = (node.responses || []).map((r) => ({
      text: r.text,
      nextNodeId: r.nextNodeId,
      effect: r.effect,
    }));

    if (isStart) {
      this.emitTypedEvent(EventType.DIALOGUE_START, {
        playerId,
        npcId,
        npcName,
        nodeId: node.id,
        text: node.text,
        responses,
        npcEntityId,
      });
    } else {
      this.emitTypedEvent(EventType.DIALOGUE_NODE_CHANGE, {
        playerId,
        npcId,
        nodeId: node.id,
        text: node.text,
        responses,
      });
    }
    // EventBridge handles forwarding these events to the client via network packets
  }

  /**
   * End a dialogue
   * Emits event that EventBridge forwards to the client via network packet
   */
  private endDialogue(playerId: string, npcId: string): void {
    this.activeDialogues.delete(playerId);

    this.emitTypedEvent(EventType.DIALOGUE_END, {
      playerId,
      npcId,
    });
    // EventBridge handles forwarding this event to the client via network packet
  }

  /**
   * Execute a dialogue effect
   */
  private executeEffect(
    playerId: string,
    npcId: string,
    effect: string,
    npcEntityId?: string,
  ): void {
    this.logger.info(
      `Executing dialogue effect: ${effect} for player ${playerId}`,
    );

    // Parse effect - format is "effectName" or "effectName:param1:param2"
    const [effectName, ...params] = effect.split(":");

    switch (effectName) {
      case "openBank":
        this.emitTypedEvent(EventType.BANK_OPEN_REQUEST, {
          playerId,
          npcId,
          npcEntityId, // Pass entity ID for distance checking
        });
        break;

      case "openShop":
      case "openStore":
        this.emitTypedEvent(EventType.STORE_OPEN_REQUEST, {
          playerId,
          npcId,
          npcEntityId, // Pass entity ID for distance checking
        });
        break;

      case "openTanner":
        this.emitTypedEvent(EventType.TANNING_INTERACT, {
          playerId,
          npcId,
          npcEntityId,
        });
        break;

      case "startQuest": {
        const questId = params[0];
        if (!questId || !isValidQuestId(questId)) {
          this.logger.warn(
            `startQuest effect has invalid quest ID: ${questId}`,
          );
          break;
        }
        // Get QuestSystem and request quest start (shows confirmation screen)
        const questSystem = this.world.getSystem("quest") as {
          requestQuestStart?: (playerId: string, questId: string) => boolean;
        };
        if (questSystem?.requestQuestStart) {
          questSystem.requestQuestStart(playerId, questId);
        } else {
          this.logger.warn("QuestSystem not available for startQuest effect");
        }
        break;
      }

      case "completeQuest": {
        const questIdToComplete = params[0];
        this.logger.info(
          `[DialogueSystem] completeQuest effect called for quest: ${questIdToComplete}`,
        );
        if (!questIdToComplete || !isValidQuestId(questIdToComplete)) {
          this.logger.warn(
            `completeQuest effect has invalid quest ID: ${questIdToComplete}`,
          );
          break;
        }
        // Get QuestSystem and complete the quest
        const questSystemForComplete = this.world.getSystem("quest") as {
          completeQuest?: (
            playerId: string,
            questId: string,
          ) => Promise<boolean>;
        };
        if (questSystemForComplete?.completeQuest) {
          this.logger.info(
            `[DialogueSystem] Calling QuestSystem.completeQuest for ${questIdToComplete}`,
          );
          questSystemForComplete
            .completeQuest(playerId, questIdToComplete)
            .then((success) => {
              this.logger.info(
                `[DialogueSystem] completeQuest returned: ${success}`,
              );
            })
            .catch((err) => {
              this.logger.error(
                `Failed to complete quest ${questIdToComplete}:`,
                err,
              );
            });
        } else {
          this.logger.warn(
            "QuestSystem not available for completeQuest effect",
          );
        }
        break;
      }

      default:
        this.logger.warn(`Unknown dialogue effect: ${effectName}`);
    }
  }

  /**
   * Check if player is in a dialogue
   */
  public isInDialogue(playerId: string): boolean {
    return this.activeDialogues.has(playerId);
  }

  /**
   * Get active dialogue state for a player
   */
  public getDialogueState(playerId: string): DialogueState | undefined {
    return this.activeDialogues.get(playerId);
  }
}
