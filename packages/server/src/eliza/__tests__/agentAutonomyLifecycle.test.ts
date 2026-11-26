import { describe, expect, it } from "vitest";

import {
  AGENT_AUTONOMY_LIFECYCLE_STATES,
  deriveAgentAutonomyLifecycleState,
  toPublicPreparationActivity,
  toPublicPreparationMode,
} from "../agentAutonomyLifecycle.js";
import { AGENT_AUTONOMY_ACTION_TYPES } from "../agentAutonomyCheckpoint.js";
import type { EmbeddedBehaviorAction } from "../managers/AgentBehaviorTicker.js";

describe("ordinary agent lifecycle categories", () => {
  it("uses the concrete action over a broader quest goal", () => {
    expect(deriveAgentAutonomyLifecycleState("questing", "gather")).toBe(
      "gathering",
    );
    expect(deriveAgentAutonomyLifecycleState("questing", "attack")).toBe(
      "training",
    );
    expect(deriveAgentAutonomyLifecycleState("questing", "smith")).toBe(
      "crafting",
    );
    expect(deriveAgentAutonomyLifecycleState("questing", "storeBuy")).toBe(
      "provisioning",
    );
    expect(deriveAgentAutonomyLifecycleState("questing", "bankWithdraw")).toBe(
      "provisioning",
    );
    expect(deriveAgentAutonomyLifecycleState("combat", "questComplete")).toBe(
      "questing",
    );
  });

  it("classifies travel from its current high-level goal", () => {
    expect(deriveAgentAutonomyLifecycleState("gathering", "move")).toBe(
      "gathering",
    );
    expect(deriveAgentAutonomyLifecycleState("combat", "navigateTo")).toBe(
      "training",
    );
    expect(deriveAgentAutonomyLifecycleState("smelting", "move")).toBe(
      "crafting",
    );
    expect(deriveAgentAutonomyLifecycleState("banking", "move")).toBe(
      "provisioning",
    );
    expect(deriveAgentAutonomyLifecycleState(null, "homeTeleport")).toBe(
      "exploring",
    );
  });

  it("maps every tracked non-idle action to a bounded operational state", () => {
    const operationalStates = new Set(
      AGENT_AUTONOMY_LIFECYCLE_STATES.filter(
        (state) => state !== "goal_selection" && state !== "reassessment",
      ),
    );
    const nonIdleActions = AGENT_AUTONOMY_ACTION_TYPES.filter(
      (
        actionType,
      ): actionType is Exclude<EmbeddedBehaviorAction["type"], "idle"> =>
        actionType !== "idle",
    );

    for (const actionType of nonIdleActions) {
      expect(
        operationalStates.has(
          deriveAgentAutonomyLifecycleState(null, actionType),
        ),
      ).toBe(true);
    }
  });

  it("maps every durable lifecycle state to a bounded public category", () => {
    expect(
      AGENT_AUTONOMY_LIFECYCLE_STATES.map(toPublicPreparationActivity),
    ).toEqual([
      "planning",
      "gathering",
      "training",
      "crafting",
      "provisioning",
      "questing",
      "exploring",
      "reassessing",
    ]);
  });

  it("reduces exact action intent to a privacy-safe work or travel mode", () => {
    expect(toPublicPreparationMode("gathering", "move")).toBe("traveling");
    expect(toPublicPreparationMode("crafting", "navigateTo")).toBe("traveling");
    expect(toPublicPreparationMode("exploring", "homeTeleport")).toBe(
      "traveling",
    );
    expect(toPublicPreparationMode("gathering", "gather")).toBe("working");
    expect(toPublicPreparationMode("crafting", "smith")).toBe("working");
    expect(toPublicPreparationMode("goal_selection", "move")).toBe("working");
    expect(toPublicPreparationMode("reassessment", "navigateTo")).toBe(
      "working",
    );
    expect(toPublicPreparationMode("provisioning", null)).toBe("working");
  });
});
